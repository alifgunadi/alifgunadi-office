'use strict';
// Shared helpers: throwaway server instances on a free port with an isolated data dir,
// so tests never touch a running office on 4317 or the real stop marker and log.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h, timeout: 3000, agent: false }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end(data);
  });
}

// Ends a server and everything it started (a task's program would otherwise be left running after a hard kill).
function endTree(child) {
  if (child.exitCode !== null || child.killed && child.signalCode) return;
  if (process.platform === 'win32') {
    try { require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* falls back */ }
  }
  child.kill('SIGKILL');
}

// options.dataDir: reuse a folder (a second server over the files of a first one); the caller removes it. options.prepare(dataDir) runs before the server starts.
async function startServer(extraEnv = {}, options = {}) {
  const port = await freePort();
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-test-'));
  if (options.prepare) options.prepare(dataDir);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    // The token file lives in the throwaway dir too: a test must never create or read the real one in the user's profile.
    env: { ...process.env, AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_DATA_DIR: dataDir, AGENT_OFFICE_TOKEN_FILE: path.join(dataDir, 'token'), AGENT_OFFICE_SETTINGS_FILE: path.join(dataDir, 'settings.json'), AGENT_OFFICE_HOME: path.join(dataDir, 'no-home'), AGENT_OFFICE_ROOTS: dataDir, AGENT_OFFICE_AUTO_STOP: '0', AGENT_OFFICE_RUNNER: '', AGENT_OFFICE_WORKSPACES: '', ...extraEnv },
    stdio: 'ignore',
    windowsHide: true,
  });
  const exit = { code: undefined };
  child.on('exit', (code) => (exit.code = code));
  for (let i = 0; i < 50; i++) {
    const res = await request(port, 'GET', '/state');
    if (res.status === 200) break;
    await sleep(100);
  }
  const header = { 'X-Agent-Office': '1' };
  return {
    port,
    dataDir,
    exit,
    kill: () => { endTree(child); return new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve))); },
    token: () => fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim(),
    request: (method, urlPath, opts) => request(port, method, urlPath, opts),
    event: (body) => request(port, 'POST', '/event', { body, headers: header }),
    state: async () => JSON.parse((await request(port, 'GET', '/state')).text),
    async stop() {
      endTree(child);
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
      if (!options.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A tiny server that records every POST body, standing in for the office when testing senders.
async function startCapture() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        received.push({ body: JSON.parse(body), headers: req.headers, url: req.url });
      } catch {
        received.push({ body: null, headers: req.headers, url: req.url });
      }
      res.writeHead(204).end();
    });
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { ROOT, sleep, freePort, request, startServer, startCapture };
