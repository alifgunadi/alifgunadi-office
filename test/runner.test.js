'use strict';
// The runner (lib/runner.js): which programs it offers, how it starts them, and how it ends them. Uses test/fixtures/fake-runner.js, never a real agent.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Tasks = require('../public/js/tasks');
const { buildEnv, resolveClaude, buildRunners, runnersView, createExecutor, PERMISSION_MODES } = require('../lib/runner');
const { createWorkspaces } = require('../lib/workspaces');

const FAKE = path.join(__dirname, 'fixtures', 'fake-runner.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-run-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error('timed out');
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function setup(options = {}) {
  const dir = tmp();
  const env = { ...process.env, ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE, 'one', 'two words']), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + dir };
  const store = Tasks.createStore();
  const changes = [];
  const exec = createExecutor({ store, runners: buildRunners(env), workspaces: createWorkspaces({ env }), onChange: () => changes.push(1), envSource: { ...process.env, ...(options.envSource || {}) }, ...options.exec });
  const send = (text, desks = ['lead-qa'], extra = {}) => {
    const made = Tasks.enqueue(store, { text, targets: desks, folder: 'w', workspaceId: 'w', runner: 'custom', ...extra }, Date.now(), options.exec && options.exec.maxConcurrent || 3).tasks;
    exec.pump();
    return made;
  };
  return { dir, store, exec, send, changes };
}

const open = [];
afterEach(() => { for (const s of open.splice(0)) s.exec.shutdown(); });
const make = (options) => { const s = setup(options); open.push(s); return s; };

describe('runner: what is offered', () => {
  it('everything is off unless the server turns it on', () => {
    const r = buildRunners({ PATH: '' });
    assert.deepEqual(runnersView(r), [
      { id: 'claude', ok: false, why: 'nonaktif di server' },
      { id: 'opencode', ok: false, why: 'nonaktif di server' },
      { id: 'antigravity', ok: false, why: 'nonaktif di server' },
    ]);
  });

  it('claude is found without a shell: claude.exe in PATH, or the native program next to the npm shim', () => {
    const a = tmp(), b = tmp();
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(a, 'claude.exe'), '');
      assert.equal(resolveClaude({ PATH: a }, 'win32'), path.join(a, 'claude.exe'));
      fs.writeFileSync(path.join(b, 'claude.cmd'), '');
      assert.equal(resolveClaude({ PATH: b }, 'win32'), null, 'a .cmd shim alone cannot be started');
      const native = path.join(b, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
      fs.mkdirSync(native, { recursive: true });
      fs.writeFileSync(path.join(native, 'claude.exe'), '');
      assert.equal(resolveClaude({ PATH: b }, 'win32'), path.join(native, 'claude.exe'));
    } else {
      fs.writeFileSync(path.join(a, 'claude'), '');
      assert.equal(resolveClaude({ PATH: a }, 'linux'), path.join(a, 'claude'));
    }
    assert.equal(resolveClaude({ PATH: tmp() }), null);
  });

  it('claude gets fixed arguments; the permission mode is one of four and bypassPermissions or manual are never accepted', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    const env = (mode) => ({ PATH: dir, ALIFGUNADI_OFFICE_RUNNER: 'claude', ALIFGUNADI_OFFICE_RUNNER_PERMISSION: mode });
    const args = (mode) => buildRunners(env(mode)).get('claude').args;
    assert.deepEqual(args(undefined), ['-p', '--output-format', 'text', '--permission-mode', 'plan']);
    assert.deepEqual(args('acceptEdits').slice(-2), ['--permission-mode', 'acceptEdits']);
    for (const bad of ['bypassPermissions', 'manual', 'plan; rm -rf /', '--dangerously-skip-permissions', '']) assert.deepEqual(args(bad).slice(-1), ['plan'], bad);
    assert.deepEqual(PERMISSION_MODES, ['plan', 'dontAsk', 'acceptEdits', 'auto']);
    assert.equal(buildRunners(env('plan')).get('claude').ok, true);
  });

  it('claude missing from PATH is reported as unavailable with the reason', () => {
    const r = buildRunners({ PATH: tmp(), ALIFGUNADI_OFFICE_RUNNER: 'claude' });
    assert.deepEqual(runnersView(r)[0], { id: 'claude', ok: false, why: 'CLI tidak ditemukan di PATH' });
  });

  it('a custom program needs an absolute path to a file and an array of strings', () => {
    const base = { ALIFGUNADI_OFFICE_RUNNER: 'custom' };
    assert.equal(buildRunners({ ...base, ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath }).get('custom').ok, true);
    assert.equal(buildRunners({ ...base, ALIFGUNADI_OFFICE_RUNNER_CMD: 'node' }).get('custom').ok, false, 'relative');
    assert.equal(buildRunners({ ...base, ALIFGUNADI_OFFICE_RUNNER_CMD: path.join(tmp(), 'missing.exe') }).get('custom').ok, false, 'not a file');
    assert.equal(buildRunners({ ...base, ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: '{"a":1}' }).get('custom').ok, false, 'not an array');
    assert.equal(buildRunners({ ...base, ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: '[1]' }).get('custom').ok, false, 'not strings');
    assert.equal(buildRunners({ ...base, ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: 'nope' }).get('custom').ok, false, 'not JSON');
  });

  it('the page sees ids and reasons only: no path, no arguments', () => {
    const r = buildRunners({ ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: '["--secret"]' });
    const text = JSON.stringify(runnersView(r));
    assert.ok(!text.includes(process.execPath) && !text.includes('--secret'));
  });
});

describe('runner: the environment of a program', () => {
  it('passes the short list and the Anthropic/Claude variables, never the settings or secrets of the server', () => {
    const out = buildEnv({ Path: 'p', PATH: 'q', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_X: '1', ALIFGUNADI_OFFICE_TOKEN_FILE: 't', ALIFGUNADI_OFFICE_RUNNER_ENV: 'X', MY_SECRET: 's', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'g', USERPROFILE: 'u' });
    assert.deepEqual(Object.keys(out).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_X', 'PATH', 'Path', 'USERPROFILE']);
  });

  it('the port and data folder of this office are passed (so hooks inside a task reach it), nothing else of ALIFGUNADI_OFFICE_*', () => {
    const out = buildEnv({ ALIFGUNADI_OFFICE_PORT: '4400', ALIFGUNADI_OFFICE_DATA_DIR: 'D:\\x', ALIFGUNADI_OFFICE_TOKEN_FILE: 't', ALIFGUNADI_OFFICE_WORKSPACES: 'w=C:\\', ALIFGUNADI_OFFICE_RUNNER: 'claude' });
    assert.deepEqual(Object.keys(out).sort(), ['ALIFGUNADI_OFFICE_DATA_DIR', 'ALIFGUNADI_OFFICE_PORT']);
  });

  it('extra names can be allowed, but never an ALIFGUNADI_OFFICE_* one', () => {
    assert.deepEqual(Object.keys(buildEnv({ MY_VAR: '1', ALIFGUNADI_OFFICE_X: '2', OTHER: '3' }, ['MY_VAR', 'ALIFGUNADI_OFFICE_X'])), ['MY_VAR']);
  });
});

describe('runner: running a task', () => {
  it('starts the program in the workspace folder, gives it the prompt on stdin, and ends the task done with its output', async () => {
    const s = make();
    const [t] = s.send('echo hallo dunia');
    assert.equal(t.status, 'running');
    await until(() => t.status === 'done');
    assert.equal(t.exitCode, 0);
    assert.equal(s.exec.output(t.id), 'got: echo hallo dunia\n');
    assert.ok(s.changes.length > 0, 'listeners are told');
    const [c] = s.send('cwd');
    await until(() => c.status === 'done');
    assert.equal(fs.realpathSync.native(s.exec.output(c.id).trim()), fs.realpathSync.native(s.dir));
  });

  it('the arguments are the fixed ones; nothing of the prompt is in them', async () => {
    const s = make();
    const [t] = s.send('args');
    await until(() => t.status === 'done');
    assert.deepEqual(JSON.parse(s.exec.output(t.id)), ['one', 'two words']);
  });

  it('shell characters in a prompt are plain text: nothing is expanded, executed or redirected', async () => {
    const s = make();
    const canary = path.join(s.dir, 'canary');
    const nasty = ['echo ; touch canary', 'echo && echo x > canary', 'echo `touch canary`', 'echo $(touch canary)', 'echo | tee canary', 'echo %PATH% $HOME', 'echo "quoted" \'single\' \\ back', 'echo \n; touch canary\n', 'echo --permission-mode bypassPermissions'];
    for (const text of nasty) {
      const [t] = s.send(text);
      await until(() => t.status === 'done');
      assert.equal(s.exec.output(t.id), 'got: ' + text + '\n', JSON.stringify(text));
    }
    assert.equal(fs.existsSync(canary), false, 'no prompt created a file');
  });

  it('a program that fails ends the task failed with its exit code', async () => {
    const s = make();
    const [t] = s.send('fail');
    await until(() => t.status === 'failed');
    assert.deepEqual([t.exitCode, t.error], [3, 'keluar dengan kode 3']);
    assert.match(s.exec.output(t.id), /boom/);
  });

  it('passes only the allowed environment to the program', async () => {
    const s = make({ envSource: { MY_SECRET: 's', ALIFGUNADI_OFFICE_TOKEN_FILE: 'x', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g' } });
    const [t] = s.send('env');
    await until(() => t.status === 'done');
    const names = JSON.parse(s.exec.output(t.id)).map((n) => n.toUpperCase());
    assert.ok(names.includes('ANTHROPIC_API_KEY'));
    for (const bad of ['MY_SECRET', 'ALIFGUNADI_OFFICE_TOKEN_FILE', 'GITHUB_TOKEN']) assert.ok(!names.includes(bad), bad);
  });

  it('keeps only the last 64 KiB of output', async () => {
    const s = make();
    const [t] = s.send('big');
    await until(() => t.status === 'done');
    const out = s.exec.output(t.id);
    assert.ok(out.length <= 64 * 1024 + 3, String(out.length));
    assert.ok(out.startsWith('[…]') && out.endsWith('x'));
  });

  it('a task whose folder or runner is not usable fails at once without starting anything', async () => {
    const s = make();
    const [a] = s.send('echo x', ['lead-qa'], { workspaceId: 'unknown' });
    assert.deepEqual([a.status, a.error], ['failed', 'folder tidak tersedia']);
    const [b] = s.send('echo x', ['lead-ui'], { runner: 'claude' });
    assert.deepEqual([b.status, b.error], ['failed', 'runner tidak tersedia']);
    assert.equal(s.exec.running(), 0);
  });

  it('runs one program per desk and at most three in all; the others wait and start as slots free up', async () => {
    const s = make();
    const desks = ['lead-qa', 'lead-ui', 'lead-dba', 'lead-ux', 'lead-devops'];
    const tasks = s.send('slow', desks);
    await until(() => s.exec.running() === 3);
    assert.deepEqual(tasks.map((t) => t.status), ['running', 'running', 'running', 'queued', 'queued']);
    s.exec.cancel(tasks[0].id);
    await until(() => tasks[3].status === 'running');
    await until(() => s.exec.running() === 3); // the cancelled program may still be dying for a moment
    assert.equal(s.exec.running(), 3, 'still three at a time');
    const second = s.send('slow', ['lead-qa'])[0];
    assert.equal(second.status, 'queued', 'three are running, so it waits');
    s.exec.cancel(second.id);
  });

  it('two prompts to one desk run one after the other', async () => {
    const s = make();
    const [a] = s.send('echo eerste');
    const [b] = s.send('echo kedua');
    assert.equal(b.status, 'queued');
    await until(() => b.status === 'done');
    assert.equal(a.status, 'done');
    assert.ok(b.startedAt >= a.finishedAt, 'the second started after the first ended');
  });
});

describe('runner: ending tasks', () => {
  it('cancelling a running task kills the program and everything it started, and the task stays cancelled', async () => {
    const s = make();
    const [t] = s.send('spawnchild');
    const pidFile = path.join(s.dir, 'child.pid');
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(grandchild));
    assert.equal(s.exec.cancel(t.id), 'running');
    await until(() => !alive(grandchild), 10000);
    assert.equal(t.status, 'cancelled');
    await sleep(300);
    assert.equal(t.status, 'cancelled', 'the exit of the killed program does not turn it into failed');
    assert.equal(s.exec.running(), 0);
  });

  it('cancelling a queued task removes it from the line, and cancelling a finished one does nothing', async () => {
    const s = make();
    const [a] = s.send('slow');
    const [b] = s.send('slow');
    assert.equal(s.exec.cancel(b.id), 'queued');
    assert.equal(b.status, 'cancelled');
    s.exec.cancel(a.id);
    assert.equal(s.exec.cancel(a.id), null);
    assert.equal(s.exec.cancel('nope'), null);
  });

  it('a task that runs too long is killed and fails with a message', async () => {
    const s = make({ exec: { timeoutMs: 400 } });
    const [t] = s.send('slow');
    await until(() => t.status === 'failed', 10000);
    assert.match(t.error, /waktu habis/);
    assert.equal(s.exec.running(), 0);
  });

  it('stopping the server ends every program', async () => {
    const s = make();
    const tasks = s.send('spawnchild', ['lead-qa']);
    const pidFile = path.join(s.dir, 'child.pid');
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    s.exec.shutdown();
    await until(() => !alive(grandchild), 10000);
    assert.equal(tasks[0].status, 'cancelled');
  });
});
