'use strict';
// AlifGunadi Office: local server that turns Claude Code hook events into a live pixel office.
// Run: node server.js   (or: bun server.js)   then open http://127.0.0.1:4317
// The office model lives in lib/office.js; this file is the HTTP and process-lifecycle layer.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createOffice } = require('./lib/office');
const { sanitizeEvent } = require('./lib/sanitize');
const { STOPPED_MARKER, LOG_PATH, DATA_DIR } = require('./lib/paths');
const { createTaskFile } = require('./lib/taskfile');
const { rotateIfLarge } = require('./lib/logfile');
const { pageCsp, applyBaseHeaders } = require('./lib/security');
const { loadOrCreateToken, createAuth } = require('./lib/auth');
const { createWorkspaces } = require('./lib/workspaces');
const { createSettings } = require('./lib/settings');
const { createIntegrations, contextText } = require('./lib/integrations');
const { buildRunners, runnersView, createExecutor, MAX_CONCURRENT } = require('./lib/runner');
const { resolveNetwork } = require('./lib/network');
const Tasks = require('./public/js/tasks');
const Mentions = require('./public/js/mentions');

const LISTEN_RETRIES = 10;
const LISTEN_RETRY_MS = 200;

const HOST = '127.0.0.1';
const PORT = Number(process.env.ALIFGUNADI_OFFICE_PORT) || 4317;
const MAX_BODY_BYTES = 64 * 1024;
const KEEPALIVE_MS = 15000;
const MAX_SSE_CLIENTS = 16;
// Auto stop: shut down after the last Claude Code session ends. Set ALIFGUNADI_OFFICE_AUTO_STOP=0 to disable.
const AUTO_STOP = process.env.ALIFGUNADI_OFFICE_AUTO_STOP !== '0';
// ALIFGUNADI_OFFICE_DEBUG=1 logs one line per event (names and ids only, never tool input).
const DEBUG = process.env.ALIFGUNADI_OFFICE_DEBUG === '1';
const SHUTDOWN_GRACE_MS = 30 * 1000;
const STALE_CHECK_MS = 5 * 60 * 1000;
const STALE_DESK_CHECK_MS = 60 * 1000;
// Always this computer; Tailscale addresses and host names only when ALIFGUNADI_OFFICE_LISTEN / _ALLOWED_HOSTS ask for them (lib/network.js).
const NETWORK = resolveNetwork(process.env, PORT);
const ALLOWED_HOSTS = NETWORK.hosts;
const ALLOWED_ORIGINS = NETWORK.origins;
const extraServers = []; // { address, server }: filled in below where the request handler exists; closed on stop and restart

const MAX_PROMPT_CHARS = 4000;
const PROMPTS_PER_MINUTE = 20;
const MAX_TARGETS_PER_PROMPT = 40;
const MAX_OPEN_TASKS = 40; // queued or running, all desks together: each one is a paid agent run
const clients = new Map(); // SSE response -> was the client logged in when it connected (only those see tasks)
let shutdownTimer = null;

// Who may start programs: one secret per user (see lib/auth.js). Without a token file nobody is logged in and the runner stays off.
let auth = null;
try { auth = createAuth(loadOrCreateToken()); } catch (err) { console.error('Could not prepare the token file; running without login:', err.message); }
const isAuthed = (req) => auth !== null && auth.isAuthed(req);

const taskStore = Tasks.createStore();
// The task list survives a restart: what was open then comes back as "interrupted" (lib/taskfile.js).
const taskFile = createTaskFile({ file: path.join(DATA_DIR, 'alifgunadi-office-tasks.json'), store: taskStore });
const restoredTasks = taskFile.load();
if (restoredTasks) console.log('Restored ' + restoredTasks + ' task(s).');
const runners = buildRunners();
const integrations = createIntegrations(); // Jira, Figma and Penpot links as read-only context; off without a token (lib/integrations.js)
const settings = createSettings();
const workspaces = createWorkspaces({ settings, exclude: [__dirname] }); // no folders until a parent folder is chosen; this checkout is never one
for (const note of workspaces.skipped) console.log('Workspace skipped: ' + note);
const executor = createExecutor({ store: taskStore, runners, workspaces, onChange: () => broadcast() });
const taskView = (t) => ({ id: t.id, batchId: t.batchId, deskId: t.deskId, text: t.text, workspaceId: t.workspaceId, runner: t.runner, status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, exitCode: t.exitCode, error: t.error });
const realEnabled = () => [...runners.values()].some((r) => r.ok);
const promptTimes = [];
const checkTimes = [];
const resolveTimes = [];
const RESOLVES_PER_MINUTE = 30;
// the folder check reads the disk for whoever asks: a few a second is plenty for typing in the dialog
function takeCheckQuota() {
  const now = Date.now();
  while (checkTimes.length && now - checkTimes[0] > 60000) checkTimes.shift();
  if (checkTimes.length >= 60) return false;
  checkTimes.push(now);
  return true;
}

function sessionView() {
  return { app: 'alifgunadi-office', schema: 1, authed: true, real: realEnabled(), runners: runnersView(runners), workspaces: workspaces.list(), integrations: integrations.providers(), maxConcurrent: MAX_CONCURRENT };
}

function cancelShutdown() {
  clearTimeout(shutdownTimer);
  shutdownTimer = null;
}

function scheduleShutdown(reason) {
  if (!AUTO_STOP || shutdownTimer) return;
  console.log(`[${new Date().toISOString()}] No active sessions (${reason}). Stopping in ${SHUTDOWN_GRACE_MS / 1000}s.`);
  shutdownTimer = setTimeout(() => {
    // A task that is still running must not be killed because the hooks of the user's own session went quiet: wait for it.
    if (executor.running() > 0) { shutdownTimer = null; scheduleShutdown('tasks still running'); return; }
    shutdown('auto stop');
  }, SHUTDOWN_GRACE_MS);
}

function broadcast() {
  taskFile.touch(); // a no-op unless the tasks changed, and then one write after a short delay
  const snap = office.snapshot();
  const plain = `data: ${JSON.stringify(snap)}\n\n`;
  let withTasks = null;
  for (const [res, loggedIn] of clients) {
    if (!loggedIn) { res.write(plain); continue; }
    if (withTasks === null) withTasks = `data: ${JSON.stringify({ ...snap, tasks: taskStore.tasks.map(taskView) })}\n\n`;
    res.write(withTasks);
  }
}

const office = createOffice({
  onChange: broadcast,
  onSessionActivity: cancelShutdown,
  onSessionsEmpty: scheduleShutdown,
});

setInterval(() => office.sweepSessions(), STALE_CHECK_MS).unref();
setInterval(() => office.sweepDesks(), STALE_DESK_CHECK_MS).unref();

function shutdown(reason) {
  console.log(`[${new Date().toISOString()}] AlifGunadi Office stopped (${reason}).`);
  executor.shutdown();
  taskFile.flush();
  server.close();
  for (const { server: extra } of extraServers) extra.close();
  for (const res of clients.keys()) res.end();
  setTimeout(() => process.exit(0), 100);
}

function manualStop() {
  try {
    fs.writeFileSync(STOPPED_MARKER, new Date().toISOString());
  } catch (err) {
    console.error('Could not write stop marker:', err.message);
  }
  shutdown('stopped from UI');
}

function restart() {
  console.log(`[${new Date().toISOString()}] Restart requested.`);
  // Release the port first; the new process retries listen until it is free.
  executor.shutdown();
  taskFile.flush();
  server.close();
  for (const { server: extra } of extraServers) extra.close();
  let out = 'ignore';
  rotateIfLarge(LOG_PATH);
  try {
    out = fs.openSync(LOG_PATH, 'a');
  } catch {
    // Logging is optional.
  }
  try {
    spawn(process.execPath, [__filename], {
      cwd: __dirname,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    }).unref();
  } catch (err) {
    console.error('Restart failed:', err.message);
  }
  for (const res of clients.keys()) res.end();
  setTimeout(() => process.exit(0), 100);
}

function readBody(req, res, onBody) {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    onBody(Buffer.concat(chunks).toString('utf8'));
  });
}

// Blocks DNS rebinding (foreign Host) and cross-origin browser requests. The custom header alone
// does not help once a rebound page is same-origin with this server.
function isTrustedRequest(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    // A cross-site page may send the user here by a link or a typed redirect (a README, a chat message, a new tab opened by a tool):
    // a top-level GET navigation. The other site cannot read the result, and framing is refused by the response headers, so it is
    // allowed. Everything else cross-site (fetch, XHR, EventSource, form posts, embeds) stays refused.
    const topLevelGet = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (!topLevelGet) return false;
  }
  return true;
}

// The page lives in public/: index.html, app.css and classic scripts in public/js. Only file names that match
// STATIC_PATH are ever read (no path from the request is joined to the disk path beyond that pattern).
const publicDir = path.join(__dirname, 'public');
const STATIC_PATH = /^\/(?:[a-z0-9-]+\.(?:css|js)|js\/[a-z0-9-]+\.js)$/;
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const indexPath = path.join(publicDir, 'index.html');
// Only these files are ever served from fonts/ (no path from the request is used).
const FONTS = { '/fonts/nunito-latin.woff2': 'nunito-latin.woff2', '/fonts/nunito-latin-ext.woff2': 'nunito-latin-ext.woff2' };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function route(req, res) {
  if (!isTrustedRequest(req)) return res.writeHead(403).end();

  if (req.method === 'GET' && req.url === '/') {
    fs.readFile(indexPath, (err, html) => {
      if (err) return res.writeHead(500).end('public/index.html not found');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': pageCsp(),
      }).end(html);
    });
    return;
  }

  if (req.method === 'GET' && STATIC_PATH.test(req.url)) {
    fs.readFile(path.join(publicDir, req.url.slice(1)), (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(req.url)], 'Cache-Control': 'no-store' }).end(data);
    });
    return;
  }

  if (req.method === 'GET' && hasOwn(FONTS, req.url)) {
    fs.readFile(path.join(__dirname, 'fonts', FONTS[req.url]), (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' }).end(data);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    if (clients.size >= MAX_SSE_CLIENTS) return res.writeHead(429).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const loggedIn = isAuthed(req);
    res.write(`data: ${JSON.stringify(loggedIn ? { ...office.snapshot(), tasks: taskStore.tasks.map(taskView) } : office.snapshot())}\n\n`);
    clients.set(res, loggedIn);
    const keepalive = setInterval(() => {
      if (loggedIn && !isAuthed(req)) return res.end(); // the session ended (expired or logged out): this stream may not keep receiving prompts
      res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepalive);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    const snap = office.snapshot();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(
      JSON.stringify({
        ok: true,
        app: snap.app,
        schema: snap.schema,
        uptime_s: Math.round(process.uptime()),
        desks: Object.keys(snap.desks).length,
        sessions: office.sessions.size,
        clients: clients.size,
      }),
    );
    return;
  }

  if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(office.snapshot()));
    return;
  }

  if (req.method === 'POST' && req.url === '/event') {
    // Custom header forces a CORS preflight, which this server never approves,
    // so random web pages in the browser cannot inject fake events.
    if (req.headers['x-alifgunadi-office'] !== '1') return res.writeHead(403).end();
    readBody(req, res, (body) => {
      let evt;
      try {
        evt = sanitizeEvent(JSON.parse(body));
      } catch {
        return res.writeHead(400).end();
      }
      if (!evt) return res.writeHead(400).end();
      try {
        if (DEBUG) console.log(`[${new Date().toISOString()}] event ${evt.hook_event_name} source=${evt.source} session=${(evt.session_id || '-').slice(0, 8)}`);
        office.handle(evt);
      } catch (err) {
        // Keep the server alive; the event is lost but the next one still works.
        console.error(`[${new Date().toISOString()}] Event handling failed (${evt.hook_event_name}):`, err);
        return res.writeHead(500).end();
      }
      res.writeHead(204).end();
    });
    return;
  }

  if (req.method === 'POST' && (req.url === '/control/stop' || req.url === '/control/restart')) {
    // Same header guard as /event: blocks cross-site requests from other pages in the browser.
    if (req.headers['x-alifgunadi-office'] !== '1') return res.writeHead(403).end();
    // They end every running task, so with the runner on they need the login too.
    if (realEnabled() && !isAuthed(req)) return json(res, 401, { error: 'login_required' });
    const action = req.url === '/control/stop' ? manualStop : restart;
    res.writeHead(202).end();
    res.on('finish', () => setImmediate(action));
    return;
  }

  if (handleTaskRoutes(req, res)) return;

  res.writeHead(404).end();
}

// ---- login, prompts and tasks. Everything here needs the session cookie, except the exchange that makes one.
const json = (res, code, body, headers = {}) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
const TASK_ID = /^\/tasks\/(t\d{1,9})\/(output|cancel)$/;

function handleTaskRoutes(req, res) {
  const url = req.url;
  const isPost = req.method === 'POST';
  if (!(url === '/integrations/resolve' || url === '/auth' || url === '/session' || url === '/prompts' || url === '/tasks' || url === '/workspaces' || url === '/settings' || url === '/settings/check' || url === '/settings/root' || TASK_ID.test(url))) return false;
  if (isPost && req.headers['x-alifgunadi-office'] !== '1') return res.writeHead(403).end(), true;

  if (isPost && url === '/auth') {
    if (auth === null) return json(res, 503, { error: 'login_unavailable' }), true;
    readBody(req, res, (body) => {
      let token;
      try { token = JSON.parse(body).token; } catch { return json(res, 400, { error: 'bad_request' }); }
      const r = auth.exchange(token);
      if (r.ok) return json(res, 200, { ok: true }, { 'Set-Cookie': r.cookie });
      json(res, 401, { error: 'wrong_token' });
    });
    return true;
  }

  if (req.method === 'GET' && url === '/session') {
    json(res, 200, isAuthed(req) ? sessionView() : { app: 'alifgunadi-office', schema: 1, authed: false });
    return true;
  }

  // From here on: logged in only.
  if (!isAuthed(req)) return json(res, 401, { error: 'login_required' }), true;

  // The parent folder of the workspaces. Ids and labels go to any logged-in page; the path itself only in /settings.
  if (req.method === 'GET' && url === '/workspaces') { json(res, 200, { workspaces: workspaces.list() }); return true; }
  if (req.method === 'GET' && url === '/settings') { json(res, 200, { root: workspaces.info() }); return true; }
  if (isPost && (url === '/settings/check' || url === '/settings/root')) {
    readBody(req, res, (body) => {
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_request' }); }
      if (!data || typeof data !== 'object' || !('path' in data) || (data.path !== null && typeof data.path !== 'string')) return json(res, 400, { error: 'bad_request' });
      if (url === '/settings/check') {
        if (!takeCheckQuota()) return json(res, 429, { error: 'too_many_checks' });
        if (data.path === null) return json(res, 400, { error: 'bad_request' });
        const r = workspaces.check(data.path);
        return json(res, r.ok ? 200 : 422, r);
      }
      const r = workspaces.setRoot(data.path);
      if (!r.ok) return json(res, r.error === 'locked_by_env' ? 409 : r.error === 'not_saved' ? 500 : 422, r);
      json(res, 200, { ok: true, root: workspaces.info(), workspaces: workspaces.list() });
    });
    return true;
  }

  // Links in a prompt: the page asks what they are (read-only, cached, limited); the server asks Jira, Figma or Penpot itself.
  if (isPost && url === '/integrations/resolve') {
    const t = Date.now();
    while (resolveTimes.length && t - resolveTimes[0] > 60000) resolveTimes.shift();
    if (resolveTimes.length >= RESOLVES_PER_MINUTE) return json(res, 429, { error: 'too_many_requests' }), true;
    resolveTimes.push(t);
    readBody(req, res, (body) => {
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'bad_request' }); }
      if (!data || !Array.isArray(data.urls) || data.urls.length > 50) return json(res, 400, { error: 'bad_request' });
      integrations.resolve(data.urls).then((results) => json(res, 200, { results })).catch(() => json(res, 500, { error: 'failed' }));
    });
    return true;
  }

  if (req.method === 'GET' && url === '/tasks') { json(res, 200, { tasks: taskStore.tasks.map(taskView) }); return true; }

  const m = TASK_ID.exec(url);
  if (m && req.method === 'GET' && m[2] === 'output') {
    const out = executor.output(m[1]);
    if (out === null) return json(res, 404, { error: 'no_output' }), true;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(out);
    return true;
  }
  if (m && isPost && m[2] === 'cancel') {
    const prev = executor.cancel(m[1]);
    json(res, prev === null ? 409 : 200, prev === null ? { error: 'not_cancellable' } : { ok: true, was: prev });
    return true;
  }

  if (isPost && url === '/prompts') {
    if (!realEnabled()) return json(res, 409, { error: 'runner_disabled' }), true;
    const now = Date.now();
    while (promptTimes.length && now - promptTimes[0] > 60000) promptTimes.shift();
    if (promptTimes.length >= PROMPTS_PER_MINUTE) return json(res, 429, { error: 'too_many_prompts' }), true;
    promptTimes.push(now); // counted before the body arrives, so parallel requests cannot all slip under the limit
    const refuse = (code, error) => { const i = promptTimes.indexOf(now); if (i >= 0) promptTimes.splice(i, 1); json(res, code, { error }); }; // a refused prompt does not use up the quota
    readBody(req, res, (body) => {
      if (taskStore.tasks.filter((t) => !Tasks.FINISHED.includes(t.status)).length >= MAX_OPEN_TASKS) return refuse(429, 'too_many_open_tasks');
      let data;
      try { data = JSON.parse(body); } catch { return refuse(400, 'bad_request'); }
      const text = data && typeof data.text === 'string' ? data.text.trim() : '';
      if (!text || text.length > MAX_PROMPT_CHARS) return refuse(400, 'bad_text');
      const runnerId = typeof data.runner === 'string' ? data.runner : '';
      const runner = runners.get(runnerId);
      if (!runner || !runner.ok) return refuse(400, 'runner_unavailable');
      const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : '';
      if (!workspaces.resolve(workspaceId)) return refuse(400, 'workspace_unavailable');
      // The server decides who a prompt is for, from the text itself (the page only helps by showing it).
      const guests = Object.keys(office.state.desks).filter((id) => !Mentions.AGENT_IDS.includes(id) && id !== 'main');
      const targets = Mentions.resolve(text, guests).targets;
      if (!targets.length) targets.push('main');
      if (targets.length > MAX_TARGETS_PER_PROMPT) return refuse(400, 'too_many_targets');
      const urls = Array.isArray(data.urls) ? data.urls.filter((u) => typeof u === 'string').slice(0, 10) : [];
      const go = (context) => {
        if (taskStore.tasks.filter((t) => !Tasks.FINISHED.includes(t.status)).length >= MAX_OPEN_TASKS) return refuse(429, 'too_many_open_tasks');
        const made = Tasks.enqueue(taskStore, { text, targets, folder: workspaceId, workspaceId, runner: runnerId }, now, MAX_CONCURRENT);
        if (context) for (const t of made.tasks) t.context = context; // read-only text in front of the prompt for the program; not shown, not saved
        executor.pump();
        broadcast();
        json(res, 202, { batchId: made.batchId, tasks: made.tasks.map((t) => t.id), rejected: made.rejected, context: Boolean(context) });
      };
      if (!urls.length) return go('');
      // The server asks for the links itself (cached): what the page showed is not taken on trust.
      let answered = false;
      const once = (context) => { if (answered) return; answered = true; try { go(context); } catch (err) { console.error('Prompt failed:', err.message); if (!res.headersSent) json(res, 500, { error: 'failed' }); } };
      integrations.resolve(urls).then((results) => once(contextText(results))).catch(() => once(''));
    });
    return true;
  }

  return false;
}

function handleRequest(req, res) {
  // A bug while handling one request must never take the whole server down.
  try {
    applyBaseHeaders(res);
    route(req, res);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Request failed:`, err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

const server = http.createServer(handleRequest);

// Tailscale addresses asked for in ALIFGUNADI_OFFICE_LISTEN: the same handler on more sockets. They are optional, so a
// failure here (Tailscale not running yet, address not assigned) is reported and never stops the loopback server.
for (const problem of NETWORK.problems) console.error(problem);
for (const address of NETWORK.listen) {
  const extra = http.createServer(handleRequest);
  let attempts = 0;
  extra.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && ++attempts < LISTEN_RETRIES) {
      setTimeout(() => extra.listen(PORT, address), LISTEN_RETRY_MS);
      return;
    }
    console.error(`Could not listen on ${address}:${PORT} (${err.code || err.message}). Is Tailscale running? Still serving ${HOST}.`);
  });
  extraServers.push({ address, server: extra });
}

let listenAttempts = 0;
server.on('error', (err) => {
  // During a restart the previous process may still hold the port for a moment.
  if (err.code === 'EADDRINUSE' && ++listenAttempts < LISTEN_RETRIES) {
    setTimeout(() => server.listen(PORT, HOST), LISTEN_RETRY_MS);
    return;
  }
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set ALIFGUNADI_OFFICE_PORT to another port.`);
  else console.error(err);
  process.exit(1);
});

// Ctrl+C or a termination request: save the task list and end the programs instead of vanishing.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

server.listen(PORT, HOST, () => {
  console.log(`AlifGunadi Office running at http://${HOST}:${PORT}`);
  for (const { address, server: extra } of extraServers) {
    extra.listen(PORT, address, () => console.log(`Also reachable over Tailscale at http://${address}:${PORT}`));
  }
});
