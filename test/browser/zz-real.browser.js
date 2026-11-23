'use strict';
// Real mode in the page: login through the address fragment, prompts sent to the server, tasks and output from the server, cancel.
// The harness server has a fake runner switched on (test/fixtures/fake-runner.js). These cases run last because they log the browser in;
// the final case logs it out again so nothing after them sees a session.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const send = async (page, text) => {
  await val(page, `document.body.focus(); dockInput.focus(); true`);
  await page.sleep(50);
  await page.type(text);
  await page.key('Enter', { modifiers: 2 });
  await page.waitFor(`!dock.sending && (dock.success !== '' || dock.error !== '')`, 6000);
};
const showTasks = (page) => val(page, `document.getElementById('tab-tasks').click(); true`);
const cardOf = (id) => `document.querySelector('.task-card[data-id="${id}"]')`;

module.exports = [
  {
    name: 'real mode: a wrong token in the fragment is removed from the address, refused, and the page stays a viewer',
    async run(page) {
      page.expectProblems(/401/);
      await page.open(page.origin + '/#token=' + 'a'.repeat(64));
      await page.waitFor(`document.getElementById('notice').textContent.includes('Token tidak cocok')`);
      assert.equal(await val(page, `location.hash`), '');
      assert.equal(await val(page, `realMode()`), false);
      assert.equal(await val(page, `document.getElementById('dock-sim').hidden`), false, 'the simulation notice stays');
      page.expectProblems(/401/);
    },
  },
  {
    name: 'real mode: the right token logs in, the fragment disappears, the dock lists the server\'s folder and runner and drops the simulation notice',
    async run(page) {
      await page.open(page.origin + '/#token=' + page.token());
      await page.waitFor(`realMode()`);
      assert.equal(await val(page, `location.hash`), '');
      assert.equal(await val(page, `document.getElementById('dock-sim').hidden`), true);
      assert.equal(await val(page, `document.getElementById('dock-folder-name').textContent`), 'w');
      assert.equal(await val(page, `document.getElementById('dock-runner-name').textContent`), 'custom');
      assert.equal(await val(page, `document.cookie.includes('alifgunadi_office_session')`), false, 'the cookie is HttpOnly: no script can read it');
      assert.ok(!(await val(page, `document.documentElement.outerHTML`)).includes(page.token()), 'the token is nowhere in the page');
      await page.waitFor(`Array.isArray(serverState.tasks)`, 5000); // the stream was restarted with the cookie
    },
  },
  {
    name: 'real mode: a prompt goes to the server, the card follows its status, and the output can be read',
    async run(page) {
      await showTasks(page);
      await send(page, 'echo hallo dunia @lead-qa');
      assert.equal(await val(page, `dock.error`), '');
      await page.waitFor(`taskStore.tasks.length === 1 && taskStore.tasks[0].status === 'done'`, 8000);
      const id = await val(page, `taskStore.tasks[0].id`);
      assert.equal(await val(page, `taskStore.tasks[0].deskId`), 'lead-qa');
      assert.equal(await val(page, `taskStore.tasks[0].exitCode`), 0);
      await page.waitFor(`!!${cardOf(id)}`);
      assert.equal(await val(page, `${cardOf(id)}.querySelector('.badge').textContent`), 'Selesai');
      assert.equal(await val(page, `!!${cardOf(id)}.querySelector('[data-action="answer"]')`), false, 'no "Jawab" in real mode');
      await val(page, `${cardOf(id)}.querySelector('[data-action="output"]').click(); true`);
      await page.waitFor(`(${cardOf(id)}.querySelector('.task-output') || {}).textContent === 'got: echo hallo dunia @lead-qa\\n'`, 5000);
    },
  },
  {
    name: 'real mode: a chip that is not typed in the text still becomes a target, because the server reads the text',
    async run(page) {
      await showTasks(page);
      await val(page, `addChip('lead-ui'); true`);
      await send(page, 'echo via chip');
      await page.waitFor(`taskStore.tasks.some((t) => t.deskId === 'lead-ui' && t.status === 'done')`, 8000);
      assert.equal(await val(page, `taskStore.tasks.filter((t) => t.deskId === 'lead-ui')[0].text`), '@lead-ui echo via chip');
    },
  },
  {
    name: 'real mode: a prompt without @mention goes to Alif Gunadi (the server defaults to him) and his name is not written into the text',
    async run(page) {
      await showTasks(page);
      await send(page, 'echo tanpa mention');
      assert.equal(await val(page, `dock.error`), '');
      await page.waitFor(`taskStore.tasks.some((t) => t.deskId === 'main' && t.status === 'done')`, 8000);
      const t = await val(page, `JSON.stringify(taskStore.tasks.filter((q) => q.deskId === 'main').map((q) => ({ text: q.text, exitCode: q.exitCode })))`).then(JSON.parse);
      assert.deepEqual(t, [{ text: 'echo tanpa mention', exitCode: 0 }]);
      // the same when his own desk is picked as the target: still no "@main" in the text
      await val(page, `addChip('main'); true`);
      await send(page, 'echo lewat chip main');
      await page.waitFor(`taskStore.tasks.some((q) => q.deskId === 'main' && q.text === 'echo lewat chip main' && q.status === 'done')`, 8000);
    },
  },
  {
    name: 'real mode: a failing program shows as failed with its message; a running task asks before it is cancelled, then ends cancelled',
    async run(page) {
      await showTasks(page);
      await send(page, 'fail @lead-dba');
      await page.waitFor(`taskStore.tasks.some((t) => t.deskId === 'lead-dba' && t.status === 'failed')`, 8000);
      const failed = await val(page, `taskStore.tasks.find((t) => t.deskId === 'lead-dba').id`);
      await page.waitFor(`!!${cardOf(failed)}`);
      assert.match(await val(page, `${cardOf(failed)}.querySelector('.task-meta').textContent`), /keluar dengan kode 3/);

      await send(page, 'slow @lead-ux');
      await page.waitFor(`taskStore.tasks.some((t) => t.deskId === 'lead-ux' && t.status === 'running')`, 8000);
      const slow = await val(page, `taskStore.tasks.find((t) => t.deskId === 'lead-ux').id`);
      await page.waitFor(`!!${cardOf(slow)}`);
      await val(page, `${cardOf(slow)}.querySelector('[data-action="cancel"]').click(); true`);
      assert.match(await val(page, `${cardOf(slow)}.querySelector('.ask').textContent`), /Batalkan/);
      await val(page, `${cardOf(slow)}.querySelector('[data-action="confirm-cancel"]').click(); true`);
      await page.waitFor(`taskStore.tasks.find((t) => t.id === '${slow}').status === 'cancelled'`, 8000);
    },
  },
  {
    name: 'real mode: a desk works while its task runs, and nothing the page shows comes from the simulated clock',
    async run(page) {
      await send(page, 'slow @lead-devops');
      await page.waitFor(`desks.find((d) => d.id === 'lead-devops').status === 'working'`, 8000);
      const id = await val(page, `taskStore.tasks.find((t) => t.deskId === 'lead-devops').id`);
      await page.sleep(2500); // the simulation would have finished a task by now
      assert.equal(await val(page, `taskStore.tasks.find((t) => t.id === '${id}').status`), 'running');
      await val(page, `api('POST', '/tasks/${id}/cancel').then(() => true)`);
      await page.waitFor(`desks.find((d) => d.id === 'lead-devops').status !== 'working'`, 8000);
    },
  },
  {
    name: 'real mode: the settings dialog reads the server, which has a fixed folder list, so it is locked and shows the count',
    async run(page) {
      await page.open(page.origin + '/#token=' + page.token());
      await page.waitFor(`realMode()`);
      await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
      await page.waitFor(`document.getElementById('settings-status').textContent.includes('dikunci')`);
      assert.equal(await val(page, `document.getElementById('settings-root').disabled`), true);
      assert.match(await val(page, `document.getElementById('settings-status').textContent`), /1 folder tersedia/);
      assert.match(await val(page, `document.getElementById('settings-source').textContent`), /ALIFGUNADI_OFFICE_WORKSPACES/);
      assert.ok(!(await val(page, `document.getElementById('settings-dialog').textContent`)).includes('ao-browser-work'), 'no path shown');
      await val(page, `closeSettings(); true`);
    },
  },
  {
    name: 'real mode: without the session the page is back to a viewer with the simulation',
    async run(page) {
      await page.clearCookies();
      await page.open(page.origin + '/');
      assert.equal(await val(page, `realMode()`), false);
      assert.equal(await val(page, `document.getElementById('dock-sim').hidden`), false);
      await page.waitFor(`serverState !== null`, 8000); // the first message of the stream
      assert.equal(await val(page, `Array.isArray(serverState.tasks)`), false, 'the stream carries no tasks any more');
      assert.equal(await val(page, `taskStore.tasks.length`), 0);
    },
  },
];
