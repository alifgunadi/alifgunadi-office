'use strict';
// Black-box tests of login, prompts and tasks: a real server.js with the runner pointed at test/fixtures/fake-runner.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer, sleep } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-runner.js');
const GUARD = { 'X-AlifGunadi-Office': '1' };
const json = (res) => JSON.parse(res.text);
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  throw new Error('timed out');
}

let srv, off, work, cookie;
before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-api-work-'));
  srv = await startServer({ ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE]), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + work });
  off = await startServer(); // a server with everything off (the default)
  const r = await srv.request('POST', '/auth', { body: { token: srv.token() }, headers: GUARD });
  cookie = r.headers['set-cookie'][0].split(';')[0];
});
after(async () => {
  await srv.stop();
  await off.stop();
  fs.rmSync(work, { recursive: true, force: true });
});

const asUser = (extra = {}) => ({ ...GUARD, Cookie: cookie, ...extra });
const send = (body, headers = asUser()) => srv.request('POST', '/prompts', { body, headers });
const prompt = (text, extra = {}) => send({ text, workspaceId: 'w', runner: 'custom', ...extra });
const task = async (id) => json(await srv.request('GET', '/tasks', { headers: { Cookie: cookie } })).tasks.find((t) => t.id === id);

describe('login', () => {
  it('the right token gives a session cookie (HttpOnly, SameSite=Strict) that does not contain the token', async () => {
    const r = await srv.request('POST', '/auth', { body: { token: srv.token() }, headers: GUARD });
    assert.equal(r.status, 200);
    const c = r.headers['set-cookie'][0];
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.ok(!c.includes(srv.token()));
  });

  it('a wrong token is refused, and repeated wrong tries never lock the right one out', async () => {
    const s = await startServer();
    try {
      for (let i = 0; i < 8; i++) assert.equal((await s.request('POST', '/auth', { body: { token: 'nope' }, headers: GUARD })).status, 401);
      assert.equal((await s.request('POST', '/auth', { body: { token: s.token() }, headers: GUARD })).status, 200);
    } finally { await s.stop(); }
  });

  it('every login is a new random session; the cookie is not the same twice and the token is not derivable from it', async () => {
    const a = (await srv.request('POST', '/auth', { body: { token: srv.token() }, headers: GUARD })).headers['set-cookie'][0];
    const b = (await srv.request('POST', '/auth', { body: { token: srv.token() }, headers: GUARD })).headers['set-cookie'][0];
    assert.notEqual(a, b);
    assert.match(a, /Max-Age=43200/);
  });

  it('a restart ends every session: the old cookie is no longer a login', async () => {
    const s = await startServer({ ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE]), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + work });
    try {
      const c = (await s.request('POST', '/auth', { body: { token: s.token() }, headers: GUARD })).headers['set-cookie'][0].split(';')[0];
      assert.equal(json(await s.request('GET', '/session', { headers: { Cookie: c } })).authed, true);
      assert.equal((await s.request('POST', '/control/restart', { headers: { ...GUARD, Cookie: c } })).status, 202);
      await sleep(300);
    } finally { await s.stop(); }
  });

  it('login needs the guard header and a trusted origin, like every other write', async () => {
    const body = { token: srv.token() };
    assert.equal((await srv.request('POST', '/auth', { body })).status, 403, 'no header');
    assert.equal((await srv.request('POST', '/auth', { body, headers: { ...GUARD, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await srv.request('POST', '/auth', { body, headers: { ...GUARD, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await srv.request('POST', '/auth', { body, headers: { ...GUARD, Host: 'evil.example' } })).status, 403);
    assert.equal((await srv.request('POST', '/auth', { body: 'not json', headers: GUARD })).status, 400);
    assert.equal((await srv.request('POST', '/auth', { body: {}, headers: GUARD })).status, 401);
  });

  it('/session tells a visitor nothing but that they are not logged in; a logged-in page sees ids and reasons, never paths', async () => {
    const anon = json(await srv.request('GET', '/session'));
    assert.deepEqual(anon, { app: 'alifgunadi-office', schema: 1, authed: false });
    const me = json(await srv.request('GET', '/session', { headers: { Cookie: cookie } }));
    assert.equal(me.authed, true);
    assert.equal(me.real, true);
    assert.deepEqual(me.workspaces, [{ id: 'w', label: 'w' }]);
    assert.deepEqual(me.runners.find((r) => r.id === 'custom'), { id: 'custom', ok: true, why: '' });
    const text = JSON.stringify(me);
    assert.ok(!text.includes(work) && !text.includes(FAKE) && !text.includes(srv.token()));
  });

  it('a cookie from another server (another token) is not accepted', async () => {
    const other = await off.request('POST', '/auth', { body: { token: off.token() }, headers: GUARD });
    const theirs = other.headers['set-cookie'][0].split(';')[0];
    assert.equal(json(await srv.request('GET', '/session', { headers: { Cookie: theirs } })).authed, false);
  });
});

describe('without a login nothing is readable or runnable', () => {
  it('every task route answers 401', async () => {
    for (const [method, url] of [['GET', '/tasks'], ['GET', '/tasks/t1/output'], ['POST', '/tasks/t1/cancel'], ['POST', '/prompts']]) {
      const r = await srv.request(method, url, { body: method === 'POST' ? { text: 'echo hi @lead-qa', workspaceId: 'w', runner: 'custom' } : undefined, headers: GUARD });
      assert.equal(r.status, 401, method + ' ' + url);
    }
  });

  it('a wrong or token-as-cookie value does not count as a login', async () => {
    for (const c of ['alifgunadi_office_session=' + 'a'.repeat(64), 'alifgunadi_office_session=' + srv.token(), 'alifgunadi_office_session=']) {
      assert.equal((await srv.request('GET', '/tasks', { headers: { Cookie: c } })).status, 401, c.slice(0, 40));
    }
  });

  it('stop and restart need the login while the runner is on, because they end every running task', async () => {
    assert.equal((await srv.request('POST', '/control/stop', { headers: GUARD })).status, 401);
    assert.equal((await srv.request('POST', '/control/restart', { headers: GUARD })).status, 401);
    assert.ok((await srv.request('GET', '/health')).status === 200, 'still running');
  });

  it('writes still need the guard header even with a cookie', async () => {
    assert.equal((await srv.request('POST', '/prompts', { body: { text: 'x', workspaceId: 'w', runner: 'custom' }, headers: { Cookie: cookie } })).status, 403);
    assert.equal((await srv.request('POST', '/tasks/t1/cancel', { headers: { Cookie: cookie } })).status, 403);
  });

  it('a cross-site request with a valid cookie is still refused by the Host/Origin/Sec-Fetch checks', async () => {
    const h = asUser({ Origin: 'https://evil.example' });
    assert.equal((await srv.request('POST', '/prompts', { body: { text: 'echo x', workspaceId: 'w', runner: 'custom' }, headers: h })).status, 403);
    assert.equal((await srv.request('GET', '/tasks', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' } })).status, 403);
  });

  it('the stream and /state carry no tasks for a visitor', async () => {
    const t = (await prompt('echo geheim @lead-qa'));
    assert.equal(t.status, 202);
    assert.ok(!('tasks' in (await srv.state())));
    assert.ok(!(await srv.request('GET', '/state')).text.includes('geheim'));
    const anon = await firstEvent(srv.port, {});
    assert.ok(!('tasks' in anon) && !JSON.stringify(anon).includes('geheim'));
    const me = await firstEvent(srv.port, { Cookie: cookie });
    assert.ok(Array.isArray(me.tasks));
  });
});

function firstEvent(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers, agent: false }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = /^data: (.*)\n\n/.exec(buf);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('no event')); }, 3000);
  });
}

describe('prompts', () => {
  it('turns a prompt with @mentions into one task per desk, runs it, and keeps the output', async () => {
    const r = await prompt('echo hallo @lead-qa @lead-ui');
    assert.equal(r.status, 202);
    const body = json(r);
    assert.equal(body.tasks.length, 2);
    for (const id of body.tasks) await until(async () => (await task(id)).status === 'done');
    const out = await srv.request('GET', '/tasks/' + body.tasks[0] + '/output', { headers: { Cookie: cookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers['content-type'], /text\/plain/);
    assert.equal(out.text, 'got: echo hallo @lead-qa @lead-ui\n');
  });

  it('a prompt without a mention goes to the main desk; the server, not the page, decides the targets', async () => {
    const r = json(await prompt('echo zonder mention', { targets: ['lead-dba'], deskId: 'lead-dba' }));
    const t = await task(r.tasks[0]);
    assert.equal(t.deskId, 'main');
    assert.equal(r.tasks.length, 1);
  });

  it('shell characters in a prompt run nothing', async () => {
    const canary = path.join(work, 'canary');
    const r = json(await prompt('echo ; touch canary `touch canary` $(touch canary) @lead-dba'));
    await until(async () => (await task(r.tasks[0])).status === 'done');
    assert.equal(fs.existsSync(canary), false);
  });

  it('the page cannot choose a folder, a program or arguments: only ids the server knows', async () => {
    for (const extra of [{ workspaceId: work }, { workspaceId: '../w' }, { workspaceId: 'x' }, { workspaceId: '' }, { workspaceId: ['w'] }]) assert.equal((await prompt('echo x', extra)).status, 400, JSON.stringify(extra));
    for (const extra of [{ runner: process.execPath }, { runner: 'claude' }, { runner: 'opencode' }, { runner: '' }, { runner: 5 }]) assert.equal((await prompt('echo x', extra)).status, 400, JSON.stringify(extra));
    const r = json(await prompt('args', { args: ['--evil'], cmd: 'calc.exe', cwd: 'C:\\' }));
    await until(async () => (await task(r.tasks[0])).status === 'done');
    const out = await srv.request('GET', '/tasks/' + r.tasks[0] + '/output', { headers: { Cookie: cookie } });
    assert.equal(out.text, '[]\n', 'no arguments reach the program');
  });

  it('rejects empty, oversized and malformed bodies', async () => {
    assert.equal((await send({ text: '', workspaceId: 'w', runner: 'custom' })).status, 400);
    assert.equal((await send({ text: '   ', workspaceId: 'w', runner: 'custom' })).status, 400);
    assert.equal((await send({ text: 'x'.repeat(4001), workspaceId: 'w', runner: 'custom' })).status, 400);
    assert.equal((await send({ text: 5, workspaceId: 'w', runner: 'custom' })).status, 400);
    assert.equal((await send('not json')).status, 400);
    assert.equal((await send('null')).status, 400);
    assert.equal((await srv.request('POST', '/prompts', { body: 'x'.repeat(70 * 1024), headers: asUser() })).status, 413);
  });

  it('an unknown task id has no output and cannot be cancelled; odd ids are not routes', async () => {
    assert.equal((await srv.request('GET', '/tasks/t999999/output', { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await srv.request('POST', '/tasks/t999999/cancel', { headers: asUser() })).status, 409);
    for (const bad of ['/tasks/../output', '/tasks/x1/output', '/tasks/t1/other', '/tasks/t1234567890/output']) assert.equal((await srv.request('GET', bad, { headers: { Cookie: cookie } })).status, 404, bad);
  });

  it('cancelling a running task ends its program', async () => {
    const r = json(await prompt('slow @lead-devops'));
    await until(async () => (await task(r.tasks[0])).status === 'running');
    const c = await srv.request('POST', '/tasks/' + r.tasks[0] + '/cancel', { headers: asUser() });
    assert.deepEqual(json(c), { ok: true, was: 'running' });
    assert.equal((await task(r.tasks[0])).status, 'cancelled');
    assert.equal((await srv.request('POST', '/tasks/' + r.tasks[0] + '/cancel', { headers: asUser() })).status, 409);
  });

  it('a failing program ends the task failed with its exit code', async () => {
    const r = json(await prompt('fail @lead-ux'));
    const t = await until(async () => { const x = await task(r.tasks[0]); return x.status === 'failed' && x; });
    assert.equal(t.exitCode, 3);
  });

  it('is limited to 20 prompts a minute', async () => {
    const s = await startServer({ ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE]), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + work });
    try {
      const c = (await s.request('POST', '/auth', { body: { token: s.token() }, headers: GUARD })).headers['set-cookie'][0].split(';')[0];
      const h = { ...GUARD, Cookie: c };
      let last;
      for (let i = 0; i < 21; i++) last = await s.request('POST', '/prompts', { body: { text: 'echo ' + i, workspaceId: 'w', runner: 'custom' }, headers: h });
      assert.equal(last.status, 429);
    } finally { await s.stop(); }
  });
});

describe('with the runner off (the default)', () => {
  it('logging in works but no prompt is accepted and nothing is offered', async () => {
    const r = await off.request('POST', '/auth', { body: { token: off.token() }, headers: GUARD });
    const c = r.headers['set-cookie'][0].split(';')[0];
    const me = json(await off.request('GET', '/session', { headers: { Cookie: c } }));
    assert.equal(me.real, false);
    assert.ok(me.runners.every((x) => !x.ok));
    assert.deepEqual(me.workspaces, []);
    const p = await off.request('POST', '/prompts', { body: { text: 'echo x', workspaceId: 'w', runner: 'custom' }, headers: { ...GUARD, Cookie: c } });
    assert.equal(p.status, 409);
  });
});

describe('the token file', () => {
  it('lives where the server was told to put it and is the same across a restart', async () => {
    const file = path.join(srv.dataDir, 'token');
    assert.match(fs.readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
  });
});
