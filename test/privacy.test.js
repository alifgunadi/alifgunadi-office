'use strict';
// A unique string typed into a prompt must not leave through the places that anyone on this PC can read without logging in.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, sleep } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-runner.js');
const GUARD = { 'X-AlifGunadi-Office': '1' };
const MARK = 'UNIQUE-MARKER-7f3a9c';

let srv, work, cookie;
before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-priv-'));
  srv = await startServer({ ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE]), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + work });
  cookie = (await srv.request('POST', '/auth', { body: { token: srv.token() }, headers: GUARD })).headers['set-cookie'][0].split(';')[0];
});
after(async () => { await srv.stop(); fs.rmSync(work, { recursive: true, force: true }); });

// the first messages of a stream, as text
function readStream(port, headers, ms) {
  return new Promise((resolve) => {
    let text = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/events', headers, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      setTimeout(() => { req.destroy(); resolve(text); }, ms);
    });
    req.on('error', () => resolve(text));
    req.end();
  });
}

describe('what a prompt does not leak', () => {
  it('the prompt text is not in /health, /state, an anonymous stream or the server log; only a logged-in client sees it', async () => {
    const r = await srv.request('POST', '/prompts', { body: { text: 'echo ' + MARK + ' @lead-qa', workspaceId: 'w', runner: 'custom' }, headers: { ...GUARD, Cookie: cookie } });
    assert.equal(r.status, 202);
    const id = JSON.parse(r.text).tasks[0];
    for (let i = 0; i < 100; i++) {
      const t = JSON.parse((await srv.request('GET', '/tasks', { headers: { Cookie: cookie } })).text).tasks.find((x) => x.id === id);
      if (t && t.status === 'done') break;
      await sleep(50);
    }
    assert.ok(!(await srv.request('GET', '/health')).text.includes(MARK), '/health');
    assert.ok(!(await srv.request('GET', '/state')).text.includes(MARK), '/state');
    const anon = await readStream(srv.port, {}, 600);
    assert.ok(anon.includes('"app":"alifgunadi-office"'), 'the anonymous stream worked');
    assert.ok(!anon.includes(MARK), 'anonymous stream');
    assert.ok(!('tasks' in JSON.parse(anon.split('\n').find((l) => l.startsWith('data: ')).slice(6))), 'no tasks key at all');
    const logged = await readStream(srv.port, { Cookie: cookie }, 600);
    assert.ok(logged.includes(MARK), 'a logged-in stream carries the task');
    const log = path.join(srv.dataDir, 'alifgunadi-office.log');
    if (fs.existsSync(log)) assert.ok(!fs.readFileSync(log, 'utf8').includes(MARK), 'the log');
    // the stand-in program echoed it back, so the output (and only the output endpoint, with a login) holds it
    assert.equal((await srv.request('GET', '/tasks/' + id + '/output', { headers: GUARD })).status, 401);
    assert.ok((await srv.request('GET', '/tasks/' + id + '/output', { headers: { Cookie: cookie } })).text.includes(MARK));
  });

  it('a prompt that is refused (bad folder, bad runner) leaves no trace of its text either', async () => {
    const secret = 'REFUSED-' + MARK;
    for (const body of [{ text: secret, workspaceId: 'nope', runner: 'custom' }, { text: secret, workspaceId: 'w', runner: 'nope' }]) {
      const r = await srv.request('POST', '/prompts', { body, headers: { ...GUARD, Cookie: cookie } });
      assert.equal(r.status, 400);
      assert.ok(!r.text.includes(secret), 'not echoed in the error');
    }
    const tasks = (await srv.request('GET', '/tasks', { headers: { Cookie: cookie } })).text;
    assert.ok(!tasks.includes('REFUSED-'));
    assert.ok(!(await srv.request('GET', '/state')).text.includes('REFUSED-'));
  });

  it('the real hook.js forwards no prompt, directory, file contents or full command, so none reaches /state', async () => {
    const { spawnSync } = require('node:child_process');
    const payload = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'FOO=1 curl https://x.example/' + MARK + ' --data ' + MARK, file_path: 'C:/secret/dir/notes.txt' }, prompt: MARK, cwd: 'C:/secret/dir' };
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'hook.js')], { input: JSON.stringify(payload), env: { ...process.env, ALIFGUNADI_OFFICE_PORT: String(srv.port), ALIFGUNADI_OFFICE_DATA_DIR: srv.dataDir }, encoding: 'utf8', timeout: 8000 });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
    await sleep(300);
    const state = (await srv.request('GET', '/state')).text;
    assert.ok(state.includes('notes.txt'), 'the file base name is shown, by design');
    assert.ok(!state.includes(MARK), 'no marker in /state');
    assert.ok(!state.includes('secret'), 'no directory in /state');
    assert.ok(!state.includes('FOO=1'), 'no variable assignment');
    assert.ok(!state.includes('x.example'), 'no argument of the command');
  });
});
