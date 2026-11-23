'use strict';
// Browser test harness: an isolated server (free port, temp data dir) and a visible Edge window driven over the
// DevTools protocol. Used by test/browser/run.js; needs Microsoft Edge (preinstalled on Windows, also on GitHub's
// windows runners) and Node 22+ (global WebSocket).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Microsoft Edge not found (set EDGE_PATH)');
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function launch() {
  const port = await freePort();
  const debugPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-browser-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-browser-profile-'));
  // The runner is switched on with a fake program (test/fixtures/fake-runner.js), but the browser is not logged in: pages start as viewers.
  // The real-mode cases log in themselves through the address fragment, like the launchers do.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-browser-work-'));
  const tokenFile = path.join(dataDir, 'token');
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, ALIFGUNADI_OFFICE_PORT: String(port), ALIFGUNADI_OFFICE_DATA_DIR: dataDir, ALIFGUNADI_OFFICE_AUTO_STOP: '0', ALIFGUNADI_OFFICE_TOKEN_FILE: tokenFile, ALIFGUNADI_OFFICE_SETTINGS_FILE: path.join(dataDir, 'settings.json'), ALIFGUNADI_OFFICE_HOME: path.join(dataDir, 'no-home'), ALIFGUNADI_OFFICE_ROOTS: dataDir,
      ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([path.join(ROOT, 'test', 'fixtures', 'fake-runner.js')]), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + workDir,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin + '/state')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  const edge = spawn(findEdge(), [`--app=${origin}/`, `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1700,1000'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 150 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith(origin));
    } catch { /* not up yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Edge did not open the page');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let nextId = 0;
  const pending = new Map();
  const problems = []; // uncaught exceptions, console errors and CSP violations
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') problems.push('exception: ' + ((d.params.exceptionDetails.exception || {}).description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') problems.push('log: ' + d.params.entry.text);
  });
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result && r.result.value;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // keep the page "focused" even if the window is behind

  const api = {
    origin, send, evaluate, problems,
    sleep,
    token: () => fs.readFileSync(tokenFile, 'utf8').trim(),
    // Open the page at an address (a fragment included) and wait until it has started.
    async open(url) {
      await send('Page.navigate', { url: 'about:blank' }); // a change of the fragment alone would not reload the page
      await sleep(200);
      await send('Page.navigate', { url });
      await sleep(300);
      await api.waitFor(`typeof booted !== 'undefined' && booted && document.getElementById('conn').textContent === 'live'`, 15000);
    },
    clearCookies: () => send('Network.clearBrowserCookies'),
    // A test that provokes a page problem on purpose (a CSP violation, say) removes it so the runner does not fail it.
    expectProblems(pattern) {
      for (let i = problems.length - 1; i >= 0; i--) if (pattern.test(problems[i])) problems.splice(i, 1);
    },
    post: (body) => fetch(origin + '/event', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AlifGunadi-Office': '1' }, body: JSON.stringify(body) }),
    async waitFor(expression, ms = 8000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await evaluate(expression)) return true; await sleep(100); }
      throw new Error('timed out waiting for: ' + expression);
    },
    async viewport(width, height, { touch = false, reducedMotion = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setTouchEmulationEnabled', { enabled: touch });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
      await sleep(900);
    },
    // modifiers: 1 = Alt, 2 = Ctrl, 4 = Meta, 8 = Shift
    async key(key, { code = key, text, modifiers = 0 } = {}) {
      const vk = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, Tab: 9, Enter: 13, Escape: 27, ' ': 32 }[key] || 0;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, modifiers, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk });
    },
    // Type text into the focused field (fires input events like real typing).
    async type(text) { await send('Input.insertText', { text }); },
    // Mouse in client (window) coordinates.
    async move(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    // One finger in client coordinates (touch emulation must be on: viewport(w, h, { touch: true })). swipe moves in `steps`
    // equal steps, `stepMs` apart: a short pause per step reads as a slow drag, a long one is slower still.
    async tap(x, y) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    async swipe(x, y0, y1, { steps = 8, stepMs = 16 } = {}) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] });
        await sleep(stepMs);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    async screenshot(file) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch { /* closing anyway */ }
      try { edge.kill(); } catch { /* already gone */ }
      try { server.kill(); } catch { /* already gone */ }
      await sleep(400);
    },
  };
  await api.waitFor(`document.getElementById('conn') && document.getElementById('conn').textContent === 'live'`, 15000);
  return api;
}

module.exports = { launch, sleep };
