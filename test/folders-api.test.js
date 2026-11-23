'use strict';
// Choosing the parent folder over HTTP: login, header guard, validation, the lock of the fixed list, and a task in a scanned folder.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-runner.js');
const GUARD = { 'X-AlifGunadi-Office': '1' };
const json = (r) => JSON.parse(r.text);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fapi-'));

let srv, fixedSrv, root, other, home, cookie, fixedCookie;
async function login(s) {
  const r = await s.request('POST', '/auth', { body: { token: s.token() }, headers: GUARD });
  return r.headers['set-cookie'][0].split(';')[0];
}
before(async () => {
  root = tmp();
  other = tmp();
  for (const n of ['alpha', 'beta']) fs.mkdirSync(path.join(root, n));
  fs.mkdirSync(path.join(other, 'gamma'));
  // a made-up user folder (the real one holds the temp folder, which would then be off limits): <base>/Users/me with its AppData
  home = path.join(tmp(), 'Users', 'me');
  fs.mkdirSync(path.join(home, 'AppData'), { recursive: true });
  srv = await startServer({ ALIFGUNADI_OFFICE_HOME: home, ALIFGUNADI_OFFICE_ROOTS: root, ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE]) });
  fixedSrv = await startServer({ ALIFGUNADI_OFFICE_WORKSPACES: 'fx=' + other });
  cookie = await login(srv);
  fixedCookie = await login(fixedSrv);
});
after(async () => {
  await srv.stop();
  await fixedSrv.stop();
  for (const d of [root, other, path.dirname(path.dirname(home))]) fs.rmSync(d, { recursive: true, force: true });
});

const asUser = (c = cookie) => ({ ...GUARD, Cookie: c });
const post = (url, body, s = srv, c = cookie) => s.request('POST', url, { body, headers: asUser(c) });

describe('who may see and change it', () => {
  it('everything needs the login', async () => {
    for (const [method, url] of [['GET', '/workspaces'], ['GET', '/settings'], ['POST', '/settings/check'], ['POST', '/settings/root']]) {
      const r = await srv.request(method, url, { body: method === 'POST' ? { path: root } : undefined, headers: GUARD });
      assert.equal(r.status, 401, method + ' ' + url);
    }
  });

  it('a change without the header, from another origin or with a foreign Host is refused', async () => {
    const body = { path: root };
    assert.equal((await srv.request('POST', '/settings/root', { body, headers: { Cookie: cookie } })).status, 403);
    assert.equal((await srv.request('POST', '/settings/root', { body, headers: { ...asUser(), Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await srv.request('POST', '/settings/root', { body, headers: { ...asUser(), 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await srv.request('POST', '/settings/root', { body, headers: { ...asUser(), Host: 'evil.example' } })).status, 403);
  });

  it('the list holds ids and labels only; the path is only in /settings', async () => {
    const list = await srv.request('GET', '/workspaces', { headers: { Cookie: cookie } });
    assert.deepEqual(json(list).workspaces, [{ id: 'alpha', label: 'alpha' }, { id: 'beta', label: 'beta' }]);
    assert.ok(!list.text.includes(root));
    const session = await srv.request('GET', '/session', { headers: { Cookie: cookie } });
    assert.ok(!session.text.includes(root));
    const st = json(await srv.request('GET', '/settings', { headers: { Cookie: cookie } }));
    assert.equal(st.root.root, root);
    assert.equal(st.root.source, 'env');
    assert.equal(st.root.count, 2);
  });
});

describe('checking and choosing', () => {
  it('bad bodies are refused', async () => {
    for (const body of ['not json', {}, { path: 5 }, { path: ['x'] }, { path: {} }]) {
      for (const url of ['/settings/check', '/settings/root']) assert.equal((await post(url, body)).status, 400, url + ' ' + JSON.stringify(body));
    }
    assert.equal((await post('/settings/check', { path: null })).status, 400);
  });

  it('check tells what would happen and saves nothing', async () => {
    const ok = await post('/settings/check', { path: other });
    assert.equal(ok.status, 200);
    assert.deepEqual(json(ok), { ok: true, count: 1 });
    for (const [p, err] of [[path.join(other, 'nope'), 'not_found'], ['relative', 'not_found'], [path.parse(other).root, 'too_broad'], [home, 'too_broad'], [path.join(home, 'AppData'), 'too_broad'], ['\\\\host\\share\\x', 'not_found'], ['//host/share/x', 'not_found']]) {
      const r = await post('/settings/check', { path: p });
      assert.equal(r.status, 422, p);
      assert.deepEqual(json(r), { ok: false, error: err });
    }
    assert.equal(json(await srv.request('GET', '/settings', { headers: { Cookie: cookie } })).root.root, root);
  });

  it('traversal and look-alike paths do not get through', async () => {
    for (const p of [path.join(root, '..', '..', '..', 'Windows'), '..\\..\\Windows', '../../etc', '%2e%2e', root + '\0', path.join(home, 'x', '..'), path.join(home, '..')]) {
      const r = await post('/settings/root', { path: p });
      assert.ok(r.status === 422 || r.status === 400, p + ' -> ' + r.status);
    }
    assert.equal(json(await srv.request('GET', '/settings', { headers: { Cookie: cookie } })).root.root, root);
  });

  it('choosing a folder switches the workspaces at once and survives a read of the file', async () => {
    const r = await post('/settings/root', { path: other });
    assert.equal(r.status, 200);
    const body = json(r);
    assert.deepEqual(body.workspaces, [{ id: 'gamma', label: 'gamma' }]);
    assert.equal(body.root.source, 'ui');
    assert.deepEqual(json(await srv.request('GET', '/workspaces', { headers: { Cookie: cookie } })).workspaces, [{ id: 'gamma', label: 'gamma' }]);
    assert.deepEqual(json(await srv.request('GET', '/session', { headers: { Cookie: cookie } })).workspaces, [{ id: 'gamma', label: 'gamma' }]);
    const file = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'settings.json'), 'utf8'));
    assert.equal(file.root, fs.realpathSync.native(other));
  });

  it('a task can run in a folder of the chosen parent, and not in one of the old parent', async () => {
    const ok = await post('/prompts', { text: 'echo hi', workspaceId: 'gamma', runner: 'custom' });
    assert.equal(ok.status, 202);
    const old = await post('/prompts', { text: 'echo hi', workspaceId: 'alpha', runner: 'custom' });
    assert.equal(old.status, 400);
  });

  it('null puts the default back', async () => {
    const r = await post('/settings/root', { path: null });
    assert.equal(r.status, 200);
    assert.equal(json(r).root.source, 'env');
    assert.deepEqual(json(r).workspaces.map((w) => w.id), ['alpha', 'beta']);
  });
});

describe('the fixed list', () => {
  it('cannot be overridden from the page and says so', async () => {
    const st = json(await fixedSrv.request('GET', '/settings', { headers: { Cookie: fixedCookie } }));
    assert.deepEqual(st.root, { source: 'fixed', locked: true, root: null, error: null, count: 1 });
    for (const url of ['/settings/check', '/settings/root']) {
      const r = await post(url, { path: root }, fixedSrv, fixedCookie);
      assert.equal(r.status, url === '/settings/root' ? 409 : 422, url);
      assert.equal(json(r).error, 'locked_by_env');
    }
    assert.deepEqual(json(await fixedSrv.request('GET', '/workspaces', { headers: { Cookie: fixedCookie } })).workspaces, [{ id: 'fx', label: 'fx' }]);
    assert.ok(!st.root.root);
  });
});

describe('limits', () => {
  it('the folder check is limited, so it cannot be used to sweep the disk', async () => {
    const codes = [];
    for (let i = 0; i < 65; i++) codes.push((await post('/settings/check', { path: root }, fixedSrv, fixedCookie)).status);
    assert.ok(codes.includes(429), 'some answer is 429');
    assert.ok(codes.indexOf(429) >= 55, 'a normal amount of typing is not limited');
  });
});

describe('what is never offered', () => {
  it('this checkout is not a workspace even when it sits inside the chosen parent folder', async () => {
    const parent = path.dirname(path.join(__dirname, '..'));
    const r = await post('/settings/check', { path: parent });
    // the parent of the checkout may be refused for other reasons on some machines; if it is accepted, the checkout must not be listed
    if (r.status === 200) {
      const set = await post('/settings/root', { path: parent });
      assert.equal(set.status, 200);
      assert.ok(!json(set).workspaces.some((w) => w.id === path.basename(path.join(__dirname, '..')).toLowerCase()));
      await post('/settings/root', { path: null });
    }
  });

  it('...unless ALIFGUNADI_OFFICE_ALLOW_CHECKOUT=1 is set: then it is listed like any other sub-folder', async () => {
    const own = await startServer({ ALIFGUNADI_OFFICE_HOME: home, ALIFGUNADI_OFFICE_ALLOW_CHECKOUT: '1' });
    try {
      const c = await login(own);
      const parent = path.dirname(path.join(__dirname, '..'));
      const check = await own.request('POST', '/settings/check', { body: { path: parent }, headers: { ...GUARD, Cookie: c } });
      if (check.status === 200) { // the parent may be refused for other reasons on some machines
        const set = await own.request('POST', '/settings/root', { body: { path: parent }, headers: { ...GUARD, Cookie: c } });
        assert.equal(set.status, 200);
        assert.ok(json(set).workspaces.some((w) => w.id === path.basename(path.join(__dirname, '..')).toLowerCase()), 'the checkout is a workspace');
      }
    } finally {
      await own.stop();
    }
  });
});
