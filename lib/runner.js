'use strict';
// Runs a task as a program on this machine. This is the part that makes the office more than a viewer, so it is deliberately small and strict:
//  - off unless the server's environment turns it on (ALIFGUNADI_OFFICE_RUNNER=claude, or custom);
//  - the program is a fixed absolute path with fixed arguments: nothing the page sends is ever part of a command line;
//  - the prompt travels over stdin, never through a shell (shell: false everywhere);
//  - it runs in a folder the server picked for an id, with only a short list of environment variables;
//  - 3 at a time, 10 minutes each, 64 KiB of output kept, and cancelling kills the whole process tree.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Tasks = require('../public/js/tasks');

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024;
const MAX_CONCURRENT = 3;
// What a claude run may do. bypassPermissions and manual are never offered: the first would let a prompt do anything, the second waits for a person.
const PERMISSION_MODES = ['plan', 'dontAsk', 'acceptEdits', 'auto'];
const DEFAULT_PERMISSION = 'plan';
const REAP_MS = 8000;
const KNOWN = ['claude', 'opencode', 'antigravity'];

// Variables a runner may inherit. Everything else (including the ALIFGUNADI_OFFICE_* settings and any secret of this server) is left out.
const ENV_KEEP = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TZ'];
const ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];
// The only ALIFGUNADI_OFFICE_* settings a program gets: where this office listens and keeps its files, so the hooks of an agent that runs
// inside a task report to this office (and not to the default port). Neither is a secret.
const PASS_THROUGH = new Set(['ALIFGUNADI_OFFICE_PORT', 'ALIFGUNADI_OFFICE_DATA_DIR']);

function buildEnv(source, extraNames = []) {
  const keep = new Set([...ENV_KEEP, ...extraNames].map((n) => n.toUpperCase()));
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    const up = name.toUpperCase();
    if (up.startsWith('ALIFGUNADI_OFFICE_') && !PASS_THROUGH.has(up)) continue;
    if (keep.has(up) || PASS_THROUGH.has(up) || ENV_PREFIXES.some((p) => up.startsWith(p))) out[name] = value;
  }
  return out;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Finds the claude program without a shell. On Windows the npm shim claude.cmd cannot be started without one, but it sits next to the real claude.exe.
function resolveClaude(env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (platform === 'win32') {
      const direct = path.join(dir, 'claude.exe');
      if (isFile(direct)) return direct;
      if (isFile(path.join(dir, 'claude.cmd'))) {
        const native = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (isFile(native)) return native;
      }
    } else {
      const p = path.join(dir, 'claude');
      if (isFile(p)) return p;
    }
  }
  return null;
}

function parseEnabled(env) {
  return new Set(String(env.ALIFGUNADI_OFFICE_RUNNER || '').toLowerCase().split(/[\s,;]+/).filter((x) => x && x !== 'off'));
}

// The runners this server offers: { id, ok, why, exec, args }. Anything not switched on is listed as unavailable with the reason.
function buildRunners(env = process.env, platform = process.platform) {
  const enabled = parseEnabled(env);
  const list = [];
  const unavailable = (id, why) => list.push({ id, ok: false, why, exec: null, args: [] });
  for (const id of KNOWN) {
    if (id !== 'claude') { unavailable(id, enabled.has(id) ? 'belum didukung di server' : 'nonaktif di server'); continue; }
    if (!enabled.has('claude')) { unavailable(id, 'nonaktif di server'); continue; }
    const exec = resolveClaude(env, platform);
    if (!exec) { unavailable(id, 'CLI tidak ditemukan di PATH'); continue; }
    const mode = PERMISSION_MODES.includes(env.ALIFGUNADI_OFFICE_RUNNER_PERMISSION) ? env.ALIFGUNADI_OFFICE_RUNNER_PERMISSION : DEFAULT_PERMISSION;
    list.push({ id, ok: true, why: '', exec, args: ['-p', '--output-format', 'text', '--permission-mode', mode] });
  }
  if (enabled.has('custom')) {
    let args = [];
    try { args = JSON.parse(env.ALIFGUNADI_OFFICE_RUNNER_ARGS || '[]'); } catch { args = null; }
    const exec = env.ALIFGUNADI_OFFICE_RUNNER_CMD;
    if (!exec || !path.isAbsolute(exec) || !isFile(exec)) unavailable('custom', 'ALIFGUNADI_OFFICE_RUNNER_CMD harus jalur absolut ke sebuah file');
    else if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) unavailable('custom', 'ALIFGUNADI_OFFICE_RUNNER_ARGS harus berupa array JSON berisi string');
    else list.push({ id: 'custom', ok: true, why: '', exec, args });
  }
  return new Map(list.map((r) => [r.id, r]));
}

// For the page: ids, whether usable and why not. No path, no arguments.
const runnersView = (runners) => [...runners.values()].map((r) => ({ id: r.id, ok: r.ok, why: r.why }));

// End a process and everything it started.
function killTree(child, platform = process.platform) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }).on('error', () => { try { child.kill(); } catch { /* gone */ } });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
  }
}

// The scheduler of the tasks: it starts programs for tasks that are running and ends tasks when their program ends.
function createExecutor({ store, runners, workspaces, onChange = () => { }, maxConcurrent = MAX_CONCURRENT, timeoutMs = RUN_TIMEOUT_MS, outputLimit = OUTPUT_LIMIT, envSource = process.env, now = Date.now }) {
  const procs = new Map();    // task id -> { child, timer, cancelled, timedOut }
  const outputs = new Map();  // task id -> text (the tail, capped)
  let closed = false;
  const extraEnv = String(envSource.ALIFGUNADI_OFFICE_RUNNER_ENV || '').split(/[\s,;]+/).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !n.toUpperCase().startsWith('ALIFGUNADI_OFFICE_'));

  const keepTail = (id, chunk) => {
    let text = (outputs.get(id) || '') + chunk;
    if (text.length > outputLimit) text = '[…]' + text.slice(text.length - outputLimit);
    outputs.set(id, text);
  };

  function end(task, status, info) {
    const p = procs.get(task.id);
    if (p) { clearTimeout(p.timer); procs.delete(task.id); }
    Tasks.finish(store, task.id, status, now(), info, maxConcurrent);
    for (const id of outputs.keys()) if (!store.tasks.some((t) => t.id === id)) outputs.delete(id); // tasks the store has dropped
    pump();
    onChange();
  }

  // If a killed program never reports that it ended (taskkill failed), give its slot back after a while instead of never.
  function reapLater(task, rec) {
    const t = setTimeout(() => {
      if (procs.get(task.id) !== rec) return;
      procs.delete(task.id);
      if (!rec.cancelled) Tasks.finish(store, task.id, 'failed', now(), { error: rec.timedOut ? 'waktu habis; program tidak berhenti' : 'tidak berhenti' }, maxConcurrent);
      pump();
      onChange();
    }, REAP_MS);
    t.unref();
  }

  function launch(task) {
    const runner = runners.get(task.runner);
    const cwd = workspaces.resolve(task.workspaceId);
    if (!runner || !runner.ok) return end(task, 'failed', { error: 'runner tidak tersedia' });
    if (!cwd) return end(task, 'failed', { error: 'folder tidak tersedia' });
    let child;
    try {
      child = spawn(runner.exec, runner.args, { cwd, env: buildEnv(envSource, extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    } catch (err) {
      return end(task, 'failed', { error: 'tidak bisa dijalankan: ' + err.code });
    }
    const rec = { child, timer: null, cancelled: false, timedOut: false };
    procs.set(task.id, rec);
    outputs.set(task.id, '');
    rec.timer = setTimeout(() => { rec.timedOut = true; killTree(child); reapLater(task, rec); }, timeoutMs);
    rec.timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => keepTail(task.id, c));
    child.stderr.on('data', (c) => keepTail(task.id, c));
    child.stdin.on('error', () => { /* the program did not read its input: its exit code tells */ });
    child.stdin.end(task.context ? task.context + String.fromCharCode(10) + task.text : task.text);
    delete task.context; // read-only text for this one start; not kept
    child.on('error', (err) => end(task, 'failed', { error: 'tidak bisa dijalankan: ' + err.code }));
    child.on('close', (code, signal) => {
      if (rec.cancelled) { procs.delete(task.id); clearTimeout(rec.timer); pump(); onChange(); return; } // the store already knows it was cancelled
      if (code === 0) end(task, 'done', { exitCode: 0 });
      else end(task, 'failed', { exitCode: code === null ? null : code, error: rec.timedOut ? 'waktu habis (' + Math.round(timeoutMs / 60000) + ' menit)' : signal ? 'dihentikan (' + signal + ')' : 'keluar dengan kode ' + code });
    });
  }

  // Start what may start now (the scheduler decides which tasks), then launch a program for each running task that has none yet.
  function pump() {
    if (closed) return; // the server is stopping: nothing new may start
    Tasks.schedule(store, now(), maxConcurrent);
    for (const t of store.tasks.slice()) if (t.status === 'running' && !procs.has(t.id)) launch(t);
  }

  const task_ = (id) => store.tasks.find((t) => t.id === id) || { id };

  return {
    pump,
    running: () => procs.size,
    output: (id) => (outputs.has(id) ? outputs.get(id) : null),
    // Cancel a queued or running task. Returns the status it had, or null if there was nothing to cancel.
    cancel(id) {
      const prev = Tasks.cancel(store, id, now(), maxConcurrent);
      if (prev === null) return null;
      const p = procs.get(id);
      if (p) { p.cancelled = true; clearTimeout(p.timer); killTree(p.child); reapLater(task_(id), p); }
      pump();
      onChange();
      return prev;
    },
    // The server is stopping: end every program it started.
    shutdown() {
      closed = true;
      for (const task of store.tasks) if (task.status === 'queued') Tasks.cancel(store, task.id, now(), 0);
      for (const [id, p] of procs) { p.cancelled = true; clearTimeout(p.timer); killTree(p.child); Tasks.cancel(store, id, now(), maxConcurrent); }
    },
  };
}

module.exports = { RUN_TIMEOUT_MS, OUTPUT_LIMIT, MAX_CONCURRENT, PERMISSION_MODES, buildEnv, resolveClaude, buildRunners, runnersView, killTree, createExecutor };
