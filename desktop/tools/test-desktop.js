'use strict';
// End-to-end tests for the AlifGunadi Office desktop app (desktop/app/AlifGunadiOffice.exe).
// Runs against an isolated server on TEST_PORT so the real office on 4317 is never stopped.
// Drives the real WebView2 through the DevTools protocol (no dependencies; Node 22+ for WebSocket).
//
// Run: node desktop/tools/test-desktop.js
// Exit code 0 = all tests passed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'desktop', 'app', 'AlifGunadiOffice.exe');
const TEST_PORT = Number(process.env.TEST_PORT) || 4399;
const CDP_APP = 9333;
const CDP_EDGE = 9334;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const MARKER = path.join(os.tmpdir(), 'alifgunadi-office.stopped');
const HOST_LOG = path.join(os.tmpdir(), 'alifgunadi-office-desktop.log');
const WINDOW_JSON = path.join(process.env.LOCALAPPDATA, 'AlifGunadiOffice', 'window.json');
const EDGE = path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const VIEW = { width: 1600, height: 900 };

const results = [];
const exceptions = [];
const consoleErrors = [];
let phase = 'setup';
let expectNetErrors = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------
function ps(command) {
  // "; exit 0": a cmdlet with -ErrorAction SilentlyContinue (e.g. no process to stop) still sets exit code 1.
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit 0`], { encoding: 'utf8' }).trim();
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`Timeout (${timeoutMs} ms): ${label}${last instanceof Error ? ' - ' + last.message : ''}`);
}

async function httpStatus(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(1000) });
    return res.status;
  } catch {
    return 0;
  }
}

const serverUp = async () => (await httpStatus(`${ORIGIN}/state`)) === 200;

function listenerPid(port) {
  const out = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  return out ? Number(out) : 0;
}

function appPids() {
  const out = ps(`@(Get-Process -Name AlifGunadiOffice -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
  return out ? out.split(',').map(Number) : [];
}

function killAllApps() {
  ps(`Get-Process -Name AlifGunadiOffice -ErrorAction SilentlyContinue | Stop-Process -Force`);
}

function ensureServer() {
  execFileSync(process.execPath, [path.join(ROOT, 'ensure-server.js')], {
    env: { ...process.env, ALIFGUNADI_OFFICE_PORT: String(TEST_PORT) },
    input: '',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function killServer() {
  const pid = listenerPid(TEST_PORT);
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
}

function launchApp(extraEnv = {}) {
  const child = spawn(APP, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ALIFGUNADI_OFFICE_PORT: String(TEST_PORT),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_APP} ${process.env.APP_EXTRA_ARGS || ''}`.trim(),
      ...extraEnv,
    },
  });
  child.unref();
  return child;
}

const WIN32 = `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);' -ErrorAction SilentlyContinue;
$p = Get-Process -Name AlifGunadiOffice | Select-Object -First 1;`;

function showWindow(cmd) {
  ps(`${WIN32} [W.U]::ShowWindow($p.MainWindowHandle, ${cmd}) | Out-Null`);
}

function appWindowTitle() {
  return ps(`(Get-Process -Name AlifGunadiOffice | Select-Object -First 1).MainWindowTitle`);
}

function measureRam(pid, samples = 5) {
  const script = path.join(__dirname, 'measure-ram.ps1');
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-RootPid', String(pid), '-Samples', String(samples), '-IntervalSec', '1', '-Json'], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

// ---------- minimal DevTools protocol client ----------
class Cdp {
  static async connect(port, urlPrefix) {
    const target = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const list = await res.json();
      return list.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
    }, 30000, `DevTools page target ${urlPrefix} on :${port}`);
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.opened;
    return cdp;
  }

  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((h) => h(msg.params));
      }
    };
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${expression}: ${r.exceptionDetails.text}`);
    return r.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

function watchPage(cdp, label) {
  cdp.on('Runtime.exceptionThrown', (p) => exceptions.push(`[${label}/${phase}] ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description || ''}`));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push({ label, phase, expected: expectNetErrors, text: p.args.map((a) => a.value ?? a.description).join(' ') });
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') consoleErrors.push({ label, phase, expected: expectNetErrors, text: `${p.entry.source}: ${p.entry.text} ${p.entry.url || ''}` });
  });
  return Promise.all([cdp.send('Runtime.enable'), cdp.send('Log.enable'), cdp.send('Page.enable')]);
}

// ---------- PNG decode (8-bit RGB/RGBA, non-interlaced) for pixel diff ----------
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp];
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

async function parityShot(cdp, dpr) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: dpr, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.eval('document.fonts.ready.then(() => true)');
  await sleep(1500);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  return Buffer.from(shot.data, 'base64');
}

// ---------- test runner ----------
async function test(name, fn) {
  if (process.env.TEST_ONLY && !new RegExp(process.env.TEST_ONLY).test(name)) return;
  phase = name;
  const started = Date.now();
  if (process.env.DEBUG_TESTS) console.log(`  .. ${name}: app processes before = ${appPids().length}`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail || '' });
    console.log(`PASS  ${name}${detail ? '  -  ' + detail : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: err.message });
    console.log(`FAIL  ${name}  -  ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  assert(fs.existsSync(APP), `App not built: ${APP} (run dotnet publish first)`);
  const startedAt = new Date();
  const markerExistedBefore = fs.existsSync(MARKER);
  const windowBackup = fs.existsSync(WINDOW_JSON) ? fs.readFileSync(WINDOW_JSON) : null;

  // Clean slate: no app, no test server, default window bounds.
  killAllApps();
  killServer();
  if (fs.existsSync(WINDOW_JSON)) fs.rmSync(WINDOW_JSON);
  await sleep(500);
  assert(!(await serverUp()), `port ${TEST_PORT} is busy`);

  let cdp;
  let appPid = 0;
  let edgeProc;
  const edgeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'alifgunadi-office-edge-'));

  try {
    await test('T01 cold start: app starts the server and shows the office', async () => {
      const t0 = Date.now();
      launchApp();
      cdp = await Cdp.connect(CDP_APP, ORIGIN);
      await watchPage(cdp, 'app');
      await waitFor(() => cdp.eval(`document.getElementById('conn').textContent === 'live'`), 15000, 'status live');
      appPid = appPids()[0];
      assert(await serverUp(), 'server not answering');
      const title = await cdp.eval('document.title');
      assert(title === 'Alifs Office', `title ${title}`);
      await waitFor(() => appWindowTitle() === 'Alifs Office', 5000, 'window title');
      return `live in ${Date.now() - t0} ms, window "${appWindowTitle()}"`;
    });

    await test('T02 window: 1600x900 CSS px (or as large as the screen allows), DPI aware, sharp canvas, Nunito font', async () => {
      const m = await cdp.eval(`(async () => {
        await document.fonts.ready;
        const c = document.getElementById('office');
        return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, cw: c.width, ccss: c.getBoundingClientRect().width,
                 font: document.fonts.check('700 13px Nunito'), ow: outerWidth, oh: outerHeight, aw: screen.availWidth, ah: screen.availHeight };
      })()`);
      // Default client area is 1600x900 CSS px, shrunk to the monitor's work area when it does not fit.
      // outerWidth in WebView2 is the WebView itself, so allow for the window frame and title bar (<= 40/60 CSS px).
      const fitsW = Math.abs(m.w - VIEW.width) <= 2 || (m.w < VIEW.width && m.w >= m.aw - 40);
      const fitsH = Math.abs(m.h - VIEW.height) <= 2 || (m.h < VIEW.height && m.h >= m.ah - 60);
      assert(fitsW && fitsH, `client ${m.w}x${m.h}, work area ${m.aw}x${m.ah}`);
      assert(m.w <= m.aw && m.h <= m.ah, `client ${m.w}x${m.h} larger than work area ${m.aw}x${m.ah}`);
      assert(Math.abs(m.cw - Math.round(m.ccss * m.dpr)) <= 1, `canvas backing ${m.cw} vs css ${m.ccss} * ${m.dpr}`);
      assert(m.font, 'Nunito not loaded');
      return `client ${m.w}x${m.h} (work area ${m.aw}x${m.ah}), devicePixelRatio ${m.dpr}, canvas ${m.cw}px for ${m.ccss} css px, Nunito loaded`;
    });

    await test('T03 hooks still drive the office (POST /event -> desk status)', async () => {
      const post = (body) => fetch(`${ORIGIN}/event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AlifGunadi-Office': '1' }, body: JSON.stringify(body),
      });
      await post({ hook_event_name: 'SessionStart', session_id: 'desktop-test' });
      await post({ hook_event_name: 'SubagentStart', session_id: 'desktop-test', agent_id: 'qa-1', agent_type: 'lead-qa' });
      const working = await waitFor(() => cdp.eval(`(deskMap.get('lead-qa') || {}).status`).then((s) => (s && s !== 'idle' ? s : null)), 5000, 'lead-qa active');
      await post({ hook_event_name: 'SubagentStop', session_id: 'desktop-test', agent_id: 'qa-1', agent_type: 'lead-qa' });
      const after = await waitFor(() => cdp.eval(`(deskMap.get('lead-qa') || {}).status`).then((s) => (s !== working ? s : null)), 5000, 'lead-qa changes after stop');
      const forbidden = await httpStatus(`${ORIGIN}/event`, { method: 'POST', body: '{}' });
      assert(forbidden === 403, `event without header returned ${forbidden}`);
      return `lead-qa: ${working} -> ${after}; request without X-AlifGunadi-Office header -> 403`;
    });

    await test('T04 navigation outside the office is blocked', async () => {
      await cdp.eval(`window.open('https://example.com'); location.href = 'https://example.com'; true`);
      await sleep(2000);
      const href = await cdp.eval('location.href');
      assert(href.startsWith(ORIGIN), `navigated to ${href}`);
      assert(appPids().length === 1, 'extra window/process opened');
      return `still on ${href}`;
    });

    await test('T05 single instance: second launch focuses the open window and exits', async () => {
      const before = appPids();
      const second = spawn(APP, [], { env: { ...process.env, ALIFGUNADI_OFFICE_PORT: String(TEST_PORT) }, stdio: 'ignore' });
      const code = await new Promise((resolve) => second.on('exit', resolve));
      await sleep(500);
      const after = appPids();
      assert(code === 0, `second instance exit code ${code}`);
      assert(after.length === 1 && after[0] === before[0], `processes ${after}`);
      return `second instance exit code 0, still 1 process (pid ${after[0]})`;
    });

    await test('T06 visual parity: app vs Edge, same Chromium engine, pixel diff', async () => {
      const dpr = await cdp.eval('devicePixelRatio');
      edgeProc = spawn(EDGE, [`--app=${ORIGIN}/`, `--user-data-dir=${edgeProfile}`, `--remote-debugging-port=${CDP_EDGE}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1700,1000'], { stdio: 'ignore', detached: true });
      edgeProc.unref();
      const edge = await Cdp.connect(CDP_EDGE, ORIGIN);
      await watchPage(edge, 'edge');
      await waitFor(() => edge.eval(`document.getElementById('conn').textContent === 'live'`), 15000, 'edge live');
      const [a, b] = await Promise.all([parityShot(cdp, dpr), parityShot(edge, dpr)]);
      edge.close();
      const pa = decodePng(a);
      const pb = decodePng(b);
      assert(pa.width === pb.width && pa.height === pb.height, `size ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
      let diff = 0;
      for (let i = 0; i < pa.data.length; i += 4) {
        if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2]) diff++;
      }
      const total = pa.width * pa.height;
      const outDir = path.join(ROOT, 'desktop', 'tools', 'out');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'parity-app.png'), a);
      fs.writeFileSync(path.join(outDir, 'parity-edge.png'), b);
      const pct = (diff / total) * 100;
      assert(pct <= 0.1, `${diff} of ${total} pixels differ (${pct.toFixed(3)}%)`);
      return `${pa.width}x${pa.height} px at DPR ${dpr}: ${diff} pixels differ (${pct.toFixed(4)}%)`;
    });

    await test('T07 RAM: app tree vs Edge --app tree (visible), and minimized', async () => {
      await sleep(2000);
      const appRam = measureRam(appPid, 5);
      const edgeRoot = Number(ps(`(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(edgeProfile)}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId`));
      const edgeRam = edgeRoot ? measureRam(edgeRoot, 5) : null;
      if (edgeProc) ps(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(edgeProfile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);

      showWindow(6); // SW_MINIMIZE
      await waitFor(() => cdp.eval(`document.visibilityState === 'hidden'`), 5000, 'page hidden when minimized');
      await sleep(4000);
      const minRam = measureRam(appPid, 5);
      showWindow(9); // SW_RESTORE
      await waitFor(() => cdp.eval(`document.visibilityState === 'visible'`), 5000, 'page visible after restore');
      await waitFor(() => cdp.eval(`document.getElementById('conn').textContent === 'live'`), 5000, 'still live after restore');
      fs.writeFileSync(path.join(ROOT, 'desktop', 'tools', 'out', 'ram.json'), JSON.stringify({ app: appRam, appMinimized: minRam, edgeApp: edgeRam }, null, 2));
      // Gate: never heavier than the same page in a dedicated Edge app window (PRD B2).
      // The 150 MB figure in the PRD was an estimate; the only flags that reach it change pixels (see research 04).
      if (edgeRam) assert(appRam.medianMB <= edgeRam.medianMB, `app ${appRam.medianMB} MB > Edge --app ${edgeRam.medianMB} MB`);
      assert(minRam.medianMB < appRam.medianMB, `minimized ${minRam.medianMB} MB not below visible ${appRam.medianMB} MB`);
      return `app visible ${appRam.medianMB} MB (${appRam.processes} proc), minimized ${minRam.medianMB} MB, Edge --app ${edgeRam ? edgeRam.medianMB + ' MB' : 'n/a'}`;
    });

    await test('T08 Restart button: new server, page reloads, back to live', async () => {
      const pidBefore = listenerPid(TEST_PORT);
      expectNetErrors = true;
      await cdp.eval(`document.getElementById('btn-restart').click(); true`);
      await waitFor(() => listenerPid(TEST_PORT) && listenerPid(TEST_PORT) !== pidBefore, 15000, 'new server pid');
      await sleep(1000);
      await waitFor(() => cdp.eval(`document.readyState === 'complete' && document.getElementById('conn').textContent === 'live'`), 15000, 'live after restart');
      expectNetErrors = false;
      return `server pid ${pidBefore} -> ${listenerPid(TEST_PORT)}`;
    });

    await test('T09 Stop button: server stops, window stays open with notice', async () => {
      expectNetErrors = true;
      await cdp.eval(`document.getElementById('btn-stop').click(); true`);
      await waitFor(() => cdp.eval(`document.getElementById('conn').textContent === 'stopped'`), 5000, 'status stopped');
      await waitFor(async () => !(await serverUp()), 5000, 'server down');
      assert(fs.existsSync(MARKER), 'stop marker missing');
      const notice = await cdp.eval(`document.getElementById('notice').textContent`);
      assert(/Server stopped/.test(notice), `notice: ${notice}`);
      assert(appPids().length === 1, 'app closed');
      return 'status "stopped", marker written, app still open';
    });

    await test('T10 F5 while server is down shows no error page; app returns by itself when server starts', async () => {
      await cdp.send('Page.reload', { ignoreCache: true });
      // Chromium's error page (chrome-error://) must never show; the host swaps in a blank page with the office background.
      await waitFor(() => cdp.eval(`!location.href.startsWith('${ORIGIN}') && !location.href.startsWith('chrome-error') && document.readyState === 'complete'`), 8000, 'offline background page');
      const errorPage = await cdp.eval(`document.body.innerText.trim()`);
      assert(errorPage === '', `visible text while offline: ${errorPage.slice(0, 80)}`);
      ensureServer();
      assert(!fs.existsSync(MARKER), 'marker not cleared by ensure-server');
      await waitFor(() => cdp.eval(`location.origin === '${ORIGIN}' && document.readyState === 'complete' && document.getElementById('conn').textContent === 'live'`), 15000, 'back to live');
      expectNetErrors = false;
      return 'blank background while down, live again without user action';
    });

    await test('T11 server auto-stop/crash: page reconnects on its own (no reload)', async () => {
      await cdp.eval(`window.__noReload = 1; true`);
      expectNetErrors = true;
      killServer();
      await waitFor(() => cdp.eval(`document.getElementById('conn').textContent === 'reconnecting...'`), 8000, 'reconnecting');
      ensureServer();
      await waitFor(() => cdp.eval(`document.getElementById('conn').textContent === 'live'`), 15000, 'live again');
      expectNetErrors = false;
      assert((await cdp.eval('window.__noReload')) === 1, 'page reloaded instead of reconnecting');
      return 'reconnecting... -> live, same page';
    });

    await test('T12 close window: app exits, server keeps running, bounds saved', async () => {
      cdp.close();
      ps(`(Get-Process -Name AlifGunadiOffice | Select-Object -First 1).CloseMainWindow() | Out-Null`);
      await waitFor(() => appPids().length === 0, 8000, 'app exited');
      assert(await serverUp(), 'server stopped with the window');
      assert(fs.existsSync(WINDOW_JSON), 'window.json not written');
      return `server still up; ${fs.readFileSync(WINDOW_JSON, 'utf8')}`;
    });

    await test('T13 relaunch: window opens at saved size and position', async () => {
      const saved = JSON.parse(fs.readFileSync(WINDOW_JSON, 'utf8'));
      launchApp();
      cdp = await Cdp.connect(CDP_APP, ORIGIN);
      await watchPage(cdp, 'app2');
      await waitFor(() => cdp.eval(`document.getElementById('conn').textContent === 'live'`), 15000, 'live');
      const rect = ps(`Add-Type -Namespace W2 -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr c); [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; }'; $p = Get-Process -Name AlifGunadiOffice | Select-Object -First 1; [W2.U]::SetThreadDpiAwarenessContext([System.IntPtr]-4) | Out-Null; $r = New-Object W2.U+RECT; [W2.U]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null; "$($r.L),$($r.T),$($r.R - $r.L),$($r.B - $r.T)"`).split(',').map(Number);
      assert(rect[0] === saved.X && rect[1] === saved.Y && rect[2] === saved.Width && rect[3] === saved.Height,
        `window ${rect} vs saved ${saved.X},${saved.Y},${saved.Width},${saved.Height}`);
      return `restored at ${rect.join(',')}`;
    });

    await test('T14 no page exceptions, no unexpected console errors, no host errors', async () => {
      const unexpected = consoleErrors.filter((e) => !e.expected);
      const hostErrors = fs.existsSync(HOST_LOG)
        ? fs.readFileSync(HOST_LOG, 'utf8').split(/\r?\n/).filter((l) => / ERROR /.test(l) && new Date(l.slice(1, l.indexOf(']'))) >= startedAt)
        : [];
      assert(exceptions.length === 0, `exceptions: ${exceptions.join(' | ')}`);
      assert(unexpected.length === 0, `console errors: ${unexpected.map((e) => `[${e.label}/${e.phase}] ${e.text}`).join(' | ')}`);
      assert(hostErrors.length === 0, `host log: ${hostErrors.join(' | ')}`);
      const expected = consoleErrors.length;
      return `0 exceptions, 0 unexpected errors (${expected} expected network errors while the server was deliberately down)`;
    });
  } finally {
    phase = 'teardown';
    if (cdp) cdp.close();
    killAllApps();
    killServer();
    ps(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(edgeProfile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    await sleep(800);
    fs.rmSync(edgeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    if (!markerExistedBefore && fs.existsSync(MARKER)) fs.rmSync(MARKER);
    if (windowBackup) fs.writeFileSync(WINDOW_JSON, windowBackup);
    else if (fs.existsSync(WINDOW_JSON)) fs.rmSync(WINDOW_JSON);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.mkdirSync(path.join(ROOT, 'desktop', 'tools', 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'desktop', 'tools', 'out', 'results.json'), JSON.stringify({ at: startedAt, results, consoleErrors, exceptions }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
