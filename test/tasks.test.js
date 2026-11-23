'use strict';
// The simulated task model of the dock (public/js/tasks.js): per-desk queues, running, asking, cancelling.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/js/tasks');

const send = (store, text, targets, now = 0) => T.enqueue(store, { text, targets, folder: 'alifgunadi-office', runner: 'claude' }, now);
const status = (store, id) => store.tasks.find((t) => t.id === id).status;

describe('tasks: queues', () => {
  it('an idle desk starts the task at once', () => {
    const s = T.createStore();
    const r = send(s, 'cek login', ['lead-qa']);
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0].status, 'running');
  });

  it('one task per distinct target, with one batch id', () => {
    const s = T.createStore();
    const r = send(s, 'semua cek', ['lead-qa', 'lead-ui', 'lead-qa']);
    assert.equal(r.tasks.length, 2);
    assert.equal(new Set(r.tasks.map((t) => t.batchId)).size, 1);
  });

  it('a busy desk queues the new task behind the running one; other desks run in parallel', () => {
    const s = T.createStore();
    send(s, 'satu', ['lead-qa', 'lead-ui']);
    const r = send(s, 'dua', ['lead-qa']);
    assert.equal(r.tasks[0].status, 'queued');
    assert.equal(s.tasks.filter((t) => t.status === 'running').length, 2, 'qa and ui each run one');
    assert.deepEqual(T.counts(s, 'lead-qa'), { running: 1, waiting: 0, queued: 1 });
  });

  it('the queued task starts when the running one finishes, in the order they were sent', () => {
    const s = T.createStore();
    const a = send(s, 'satu', ['lead-qa']).tasks[0];
    const b = send(s, 'dua', ['lead-qa']).tasks[0];
    const c = send(s, 'tiga', ['lead-qa']).tasks[0];
    assert.deepEqual(T.queuePosition(s, b), { place: 1, of: 2 });
    assert.deepEqual(T.queuePosition(s, c), { place: 2, of: 2 });
    T.step(s, a.runMs + 1);
    assert.equal(status(s, a.id), 'done');
    assert.equal(status(s, b.id), 'running');
    assert.equal(status(s, c.id), 'queued');
  });

  it('a desk accepts at most ten waiting tasks and reports the rest as rejected', () => {
    const s = T.createStore();
    send(s, 'jalan', ['lead-qa']);
    for (let i = 0; i < 10; i++) assert.equal(send(s, 'antre ' + i, ['lead-qa']).rejected.length, 0);
    const r = send(s, 'terlalu banyak', ['lead-qa']);
    assert.deepEqual(r.rejected, [{ deskId: 'lead-qa', reason: 'queue_full' }]);
    assert.equal(r.tasks.length, 0);
  });

  it('keeps at most 100 tasks by dropping the oldest finished ones', () => {
    const s = T.createStore();
    for (let i = 0; i < 120; i++) { const t = send(s, 'x' + i, ['lead-qa'], i).tasks[0]; T.cancel(s, t.id, i); }
    send(s, 'baru', ['lead-qa'], 200);
    assert.ok(s.tasks.length <= T.MAX_TASKS + 1, String(s.tasks.length));
    assert.equal(s.tasks[s.tasks.length - 1].text, 'baru');
  });
});

describe('tasks: running, asking, cancelling', () => {
  it('a task runs for its time (6 to 11 seconds) and then is done', () => {
    const s = T.createStore();
    const t = send(s, 'cek', ['lead-qa']).tasks[0];
    assert.ok(t.runMs >= 6000 && t.runMs < 11000);
    T.step(s, t.runMs - 1);
    assert.equal(t.status, 'running');
    T.step(s, t.runMs + 1);
    assert.equal(t.status, 'done');
  });

  it('a prompt with a question mark stops once to ask, and goes on after the answer', () => {
    const s = T.createStore();
    const t = send(s, 'apakah token Jira boleh dipakai?', ['lead-security']).tasks[0];
    T.step(s, 3500);
    assert.equal(t.status, 'waiting_input');
    T.step(s, 60000);
    assert.equal(t.status, 'waiting_input', 'it waits for as long as it takes');
    assert.equal(T.answer(s, t.id, 60000), true);
    assert.equal(t.status, 'running');
    T.step(s, 60000 + t.runMs + 1);
    assert.equal(t.status, 'done', 'and does not ask a second time');
  });

  it('cancelling a queued task just removes it from the line', () => {
    const s = T.createStore();
    send(s, 'jalan', ['lead-qa']);
    const q = send(s, 'antre', ['lead-qa']).tasks[0];
    assert.equal(T.cancel(s, q.id, 10), 'queued');
    assert.equal(q.status, 'cancelled');
    assert.equal(T.counts(s, 'lead-qa').queued, 0);
  });

  it('cancelling the running task starts the next one', () => {
    const s = T.createStore();
    const a = send(s, 'jalan', ['lead-qa']).tasks[0];
    const b = send(s, 'antre', ['lead-qa']).tasks[0];
    assert.equal(T.cancel(s, a.id, 10), 'running');
    assert.equal(b.status, 'running');
  });

  it('cannot cancel what is already finished, or answer what is not waiting', () => {
    const s = T.createStore();
    const a = send(s, 'cek', ['lead-qa']).tasks[0];
    T.step(s, a.runMs + 1);
    assert.equal(T.cancel(s, a.id, 99999), null);
    assert.equal(T.answer(s, a.id, 99999), false);
    assert.equal(T.cancel(s, 'nope', 1), null);
  });
});

describe('tasks: what the screen shows', () => {
  it('the filters follow the rules of the design: Aktif = running, Menunggu = queued + waiting, Selesai = done, failed, cancelled', () => {
    const s = T.createStore();
    const run = send(s, 'jalan', ['lead-qa']).tasks[0];
    const queued = send(s, 'antre', ['lead-qa']).tasks[0];
    const ask = send(s, 'tanya?', ['lead-ui']).tasks[0];
    T.step(s, 3500);
    const cancelled = send(s, 'batal', ['lead-dba']).tasks[0];
    T.cancel(s, cancelled.id, 4000);
    const ids = (f) => T.filterTasks(s, f).map((t) => t.id).sort();
    assert.deepEqual(ids('all'), [run, queued, ask, cancelled].map((t) => t.id).sort());
    assert.deepEqual(ids('active'), [run.id].sort());
    assert.deepEqual(ids('waiting'), [queued.id, ask.id].sort());
    assert.deepEqual(ids('done'), [cancelled.id]);
  });

  it('a desk shows working while a task runs, waiting when it asks, and done for eight seconds after', () => {
    const s = T.createStore();
    const t = send(s, 'cek halaman login', ['lead-qa'], 0).tasks[0];
    assert.deepEqual(T.deskView(s, 'lead-qa', 1000), { status: 'working', activity: 'cek halaman login' });
    assert.equal(T.deskView(s, 'lead-ui', 1000), null, 'other desks keep their real status');
    T.step(s, t.runMs + 1);
    assert.equal(T.deskView(s, 'lead-qa', t.runMs + 2).status, 'done');
    assert.equal(T.deskView(s, 'lead-qa', t.runMs + 1 + T.DONE_SHOWN_MS + 1), null);
    const q = send(s, 'ada pertanyaan?', ['lead-ux'], 0).tasks[0];
    T.step(s, 3100);
    assert.equal(T.deskView(s, 'lead-ux', 3100).status, 'waiting');
    assert.ok(q);
  });

  it('long summaries are cut to 32 characters', () => {
    assert.equal(T.summary('a'.repeat(50)).length, 32);
    assert.equal(T.summary('  spasi   banyak  '), 'spasi banyak');
  });

  it('the load is active tasks out of all tasks that were not cancelled', () => {
    const s = T.createStore();
    assert.deepEqual(T.load(s), { active: 0, total: 0 });
    send(s, 'a', ['lead-qa']);
    send(s, 'b', ['lead-qa']);
    const c = send(s, 'c', ['lead-ui']).tasks[0];
    T.cancel(s, c.id, 5);
    assert.deepEqual(T.load(s), { active: 1, total: 2 });
  });
});

describe('tasks: limits and results for a real runner', () => {
  it('at most maxRunning tasks run at once; the others wait in the order they were sent and start as slots free up', () => {
    const s = T.createStore();
    const desks = ['lead-qa', 'lead-ui', 'lead-dba', 'lead-ux', 'lead-devops'];
    const made = T.enqueue(s, { text: 'x', targets: desks }, 0, 3).tasks;
    assert.deepEqual(made.map((t) => t.status), ['running', 'running', 'running', 'queued', 'queued']);
    const started = T.finish(s, made[1].id, 'done', 10, { exitCode: 0 }, 3);
    assert.deepEqual(started.map((t) => t.id), [made[3].id], 'the oldest waiting task takes the free slot');
    assert.deepEqual(s.tasks.map((t) => t.status), ['running', 'done', 'running', 'running', 'queued']);
    T.cancel(s, made[0].id, 20, 3);
    assert.equal(s.tasks[4].status, 'running', 'cancelling a running task frees a slot too');
  });

  it('a desk still runs one task at a time when slots are free, and a busy desk does not take a slot while queued', () => {
    const s = T.createStore();
    T.enqueue(s, { text: 'a', targets: ['lead-qa'] }, 0, 3);
    const b = T.enqueue(s, { text: 'b', targets: ['lead-qa'] }, 1, 3).tasks[0];
    assert.equal(b.status, 'queued');
    const c = T.enqueue(s, { text: 'c', targets: ['lead-ui'] }, 2, 3).tasks[0];
    assert.equal(c.status, 'running');
  });

  it('finish records the exit code and a short error, frees the desk, and ignores a task that is already finished', () => {
    const s = T.createStore();
    const a = T.enqueue(s, { text: 'a', targets: ['lead-qa'] }, 0, 3).tasks[0];
    const b = T.enqueue(s, { text: 'b', targets: ['lead-qa'] }, 1, 3).tasks[0];
    T.finish(s, a.id, 'failed', 5, { exitCode: 2, error: 'x'.repeat(1000) }, 3);
    assert.deepEqual([a.status, a.exitCode, a.error.length, b.status], ['failed', 2, 300, 'running']);
    assert.deepEqual(T.finish(s, a.id, 'done', 6, { exitCode: 0 }, 3), [], 'a finished task cannot be finished again');
    assert.equal(a.status, 'failed');
    const c = T.enqueue(s, { text: 'c', targets: ['lead-ui'] }, 7, 3).tasks[0];
    T.cancel(s, c.id, 8, 3);
    assert.deepEqual(T.finish(s, c.id, 'done', 9, {}, 3), [], 'a cancelled task stays cancelled when its process exits');
    assert.equal(c.status, 'cancelled');
    assert.deepEqual(T.finish(s, 'nope', 'done', 1, {}, 3), []);
    assert.deepEqual(T.finish(s, b.id, 'running', 1, {}, 3), [], 'only a final status can be reported');
  });

  it('keeps the workspace id of a task', () => {
    const s = T.createStore();
    const t = T.enqueue(s, { text: 'a', targets: ['lead-qa'], workspaceId: 'alifgunadi-office', runner: 'claude', folder: 'alifgunadi-office' }, 0, 3).tasks[0];
    assert.deepEqual([t.workspaceId, t.runner, t.folder], ['alifgunadi-office', 'claude', 'alifgunadi-office']);
  });
});
