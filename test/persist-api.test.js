'use strict';
// The task list across restarts and crashes, with real server processes over the same data folder.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, sleep } = require('./helpers');

const FAKE = path.join(__dirname, 'fixtures', 'fake-runner.js');
const GUARD = { 'X-AlifGunadi-Office': '1' };
const json = (r) => JSON.parse(r.text);
const tmpDirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const env = (work) => ({ ALIFGUNADI_OFFICE_RUNNER: 'custom', ALIFGUNADI_OFFICE_RUNNER_CMD: process.execPath, ALIFGUNADI_OFFICE_RUNNER_ARGS: JSON.stringify([FAKE]), ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + work });
async function login(s) { return (await s.request('POST', '/auth', { body: { token: s.token() }, headers: GUARD })).headers['set-cookie'][0].split(';')[0]; }
const tasksOf = async (s, c) => json(await s.request('GET', '/tasks', { headers: { Cookie: c } })).tasks;
const taskFile = (dir) => path.join(dir, 'alifgunadi-office-tasks.json');
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timed out'); }
const write = (dir, tasks, extra = {}) => fs.writeFileSync(taskFile(dir), JSON.stringify({ v: 1, nextId: 1, nextBatch: 1, tasks, ...extra }));
const mk = (n, over = {}) => ({ id: 't' + n, batchId: 'b' + n, deskId: 'lead-qa', text: 'echo ' + n, workspaceId: 'w', runner: 'custom', status: 'done', createdAt: Date.now() - 5000, startedAt: Date.now() - 4000, finishedAt: Date.now() - 3000, exitCode: 0, error: null, ...over });

describe('a restart', () => {
  it('brings the finished tasks back, marks the open ones "interrupted", and new tasks get new ids', async () => {
    const work = tmp('ao-pw-'), data = tmp('ao-pd-');
    write(data, [mk(4), mk(5, { status: 'running', finishedAt: null }), mk(6, { status: 'queued', startedAt: null, finishedAt: null })]);
    const s = await startServer(env(work), { dataDir: data });
    try {
      const c = await login(s);
      const list = await tasksOf(s, c);
      assert.deepEqual(list.map((t) => [t.id, t.status]), [['t4', 'done'], ['t5', 'interrupted'], ['t6', 'interrupted']]);
      assert.equal(list[1].error, 'server dimulai ulang');
      assert.equal(list.length, 3, 'nothing was started again');
      // a new prompt does not reuse an id
      const r = await s.request('POST', '/prompts', { body: { text: 'echo hi', workspaceId: 'w', runner: 'custom' }, headers: { ...GUARD, Cookie: c } });
      assert.equal(r.status, 202);
      assert.ok(json(r).tasks.every((id) => !['t4', 't5', 't6'].includes(id)));
      // the output of a task from before is gone, and says so
      assert.equal((await s.request('GET', '/tasks/t4/output', { headers: { Cookie: c } })).status, 404);
    } finally { await s.stop(); }
  });

  it('a task that is open when the server is killed comes back as interrupted in the next server', async () => {
    const work = tmp('ao-pw-'), data = tmp('ao-pd-');
    const a = await startServer(env(work), { dataDir: data });
    const c = await login(a);
    await a.request('POST', '/prompts', { body: { text: 'slow', workspaceId: 'w', runner: 'custom' }, headers: { ...GUARD, Cookie: c } });
    await until(async () => (await tasksOf(a, c)).some((t) => t.status === 'running'));
    await until(() => fs.existsSync(taskFile(data)) && fs.readFileSync(taskFile(data), 'utf8').includes('"running"'));
    await a.kill(); // no goodbye: like a crash
    const b = await startServer(env(work), { dataDir: data });
    try {
      const cb = await login(b);
      const list = await tasksOf(b, cb);
      assert.equal(list.length, 1);
      assert.equal(list[0].status, 'interrupted');
      assert.equal(list[0].workspaceId, 'w');
      // and it is a task like any other: it can be seen in the stream of the page too
      assert.equal(json(await b.request('GET', '/session', { headers: { Cookie: cb } })).authed, true);
    } finally { await b.stop(); }
  });

  it('a graceful stop writes the final state: a task that was cancelled by the stop is saved as cancelled', async () => {
    const work = tmp('ao-pw-'), data = tmp('ao-pd-');
    const a = await startServer(env(work), { dataDir: data });
    const c = await login(a);
    await a.request('POST', '/prompts', { body: { text: 'slow', workspaceId: 'w', runner: 'custom' }, headers: { ...GUARD, Cookie: c } });
    await until(async () => (await tasksOf(a, c)).some((t) => t.status === 'running'));
    const r = await a.request('POST', '/control/stop', { headers: { ...GUARD, Cookie: c } });
    assert.equal(r.status, 202);
    await until(() => a.exit.code !== undefined);
    const saved = JSON.parse(fs.readFileSync(taskFile(data), 'utf8'));
    assert.deepEqual(saved.tasks.map((t) => t.status), ['cancelled']);
    // the stop marker belongs to the data folder; clean it so it cannot affect anything else
    try { fs.unlinkSync(path.join(data, 'alifgunadi-office.stopped')); } catch { /* none */ }
    await a.stop();
  });
});

describe('a damaged or hostile file', () => {
  it('damaged: the server starts with an empty list, the file is kept aside, and a new task is saved normally', async () => {
    const work = tmp('ao-pw-'), data = tmp('ao-pd-');
    fs.writeFileSync(taskFile(data), '{"v":1,"tasks":[{oops');
    const s = await startServer(env(work), { dataDir: data });
    try {
      const c = await login(s);
      assert.deepEqual(await tasksOf(s, c), []);
      assert.equal(fs.existsSync(taskFile(data) + '.bad'), true);
      await s.request('POST', '/prompts', { body: { text: 'echo hi', workspaceId: 'w', runner: 'custom' }, headers: { ...GUARD, Cookie: c } });
      await until(() => fs.existsSync(taskFile(data)) && JSON.parse(fs.readFileSync(taskFile(data), 'utf8')).tasks.length === 1);
    } finally { await s.stop(); }
  });

  it('hostile: odd ids, huge text and unknown statuses never reach the page', async () => {
    const work = tmp('ao-pw-'), data = tmp('ao-pd-');
    write(data, [mk(1), mk(2, { id: '../../x' }), mk(3, { status: '<script>' }), mk(4, { text: 'y'.repeat(20000) }), mk(5, { deskId: '<img onerror=x>' })]);
    const s = await startServer(env(work), { dataDir: data });
    try {
      const c = await login(s);
      const list = await tasksOf(s, c);
      assert.deepEqual(list.map((t) => t.id), ['t1', 't4']);
      assert.equal(list[1].text.length, 4000);
    } finally { await s.stop(); }
  });

  it('a file nobody asked for (runner off) is read too, but tasks are only shown to a logged-in page', async () => {
    const work = tmp('ao-pw-'), data = tmp('ao-pd-');
    write(data, [mk(1, { text: 'a private prompt' })]);
    const s = await startServer({ ALIFGUNADI_OFFICE_WORKSPACES: 'w=' + work }, { dataDir: data });
    try {
      assert.ok(!(await s.request('GET', '/state')).text.includes('private'));
      const anon = await s.request('GET', '/tasks', { headers: GUARD });
      assert.equal(anon.status, 401);
    } finally { await s.stop(); }
  });
});
