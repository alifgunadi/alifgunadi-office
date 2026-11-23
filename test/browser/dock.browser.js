'use strict';
// The prompt dock (Mode simulasi): compact and expanded, @mentions, sending, the confirmation for @everyone, folder and runner
// menus, and the task cards with their queue, cancel and answer flows.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const focusInput = async (page) => { await val(page, `document.body.focus(); dockInput.focus(); true`); await page.sleep(50); };
const hint = (page) => val(page, `document.getElementById('dock-hint').textContent`);
const ctrlEnter = (page) => page.key('Enter', { modifiers: 2 });
// send a prompt and wait until the simulated round trip is over
const sendPrompt = async (page, text) => {
  await focusInput(page);
  await page.type(text);
  await ctrlEnter(page);
  await page.waitFor(`!dock.sending && dock.success !== ''`, 4000);
};
const showTasks = (page) => val(page, `document.getElementById('tab-tasks').click(); true`);

module.exports = [
  {
    name: 'dock: starts compact with the permanent "Mode simulasi" notice, a labelled region and a combobox',
    async run(page) {
      const r = JSON.parse(await val(page, `JSON.stringify({
        state: dockEl.dataset.state, region: dockEl.getAttribute('role') + ':' + dockEl.getAttribute('aria-label'),
        sim: document.getElementById('dock-sim').textContent, simVisible: document.getElementById('dock-sim').getBoundingClientRect().height > 0,
        folderShown: document.getElementById('dock-folder').getBoundingClientRect().height > 0,
        combo: [dockInput.getAttribute('role'), dockInput.getAttribute('aria-controls'), dockInput.getAttribute('aria-expanded'), dockInput.getAttribute('aria-autocomplete')],
        list: document.getElementById('mention-list').getAttribute('role'), sendEnabled: !dockSend.disabled, ph: dockInput.placeholder })`));
      assert.equal(r.state, 'compact');
      assert.equal(r.region, 'region:Prompt dan perintah agent');
      assert.match(r.sim, /Mode simulasi/);
      assert.equal(r.simVisible, true, 'the notice is visible even when compact');
      assert.equal(r.folderShown, false, 'folder and runner appear when the dock opens');
      assert.deepEqual(r.combo, ['combobox', 'mention-list', 'false', 'list']);
      assert.equal(r.list, 'listbox');
      assert.equal(r.sendEnabled, true);
      assert.match(r.ph, /@mention/);
    },
  },
  {
    name: 'dock: "/" jumps to the dock from the page, but not while typing elsewhere; Escape leaves it again',
    async run(page) {
      await val(page, `document.body.focus(); true`);
      await page.key('/', { text: '/' });
      assert.equal(await val(page, `document.activeElement === dockInput && dockEl.dataset.state`), 'expanded');
      assert.equal(await val(page, `dockInput.value`), '', 'the slash is not typed into the field');
      await page.key('Escape');
      assert.equal(await val(page, `document.activeElement === stage`), true, 'focus goes back to the floor');
      await page.sleep(400);
      assert.equal(await val(page, `dockEl.dataset.state`), 'compact', 'an empty dock shrinks again');
      await val(page, `(() => { const i = document.createElement('input'); i.id = 'tmp'; document.body.append(i); i.focus(); return true; })()`);
      await page.key('/', { text: '/' });
      assert.equal(await val(page, `document.activeElement.id`), 'tmp', 'a slash typed in another field stays there');
      await val(page, `document.getElementById('tmp').remove(); true`);
    },
  },
  {
    name: 'dock: typing @ offers the three groups, arrows and Enter insert, Escape closes only the popover',
    async run(page) {
      await focusInput(page);
      await page.type('halo @');
      await page.waitFor(`!mentionList.hidden`);
      const r = JSON.parse(await val(page, `JSON.stringify({ groups: [...mentionList.querySelectorAll('.group')].map((g) => g.textContent), opts: [...mentionList.querySelectorAll('[role=option]')].slice(0, 5).map((o) => o.textContent), expanded: dockInput.getAttribute('aria-expanded'), active: dockInput.getAttribute('aria-activedescendant'), count: mentionList.querySelectorAll('[role=option]').length })`));
      assert.deepEqual(r.groups, ['Semua Tim', 'Divisi', 'Agent']);
      assert.match(r.opts[0], /@everyone \/ @all11 agent/);
      assert.match(r.opts[1], /@product5 agent/);
      assert.equal(r.expanded, 'true');
      assert.equal(r.active, 'mention-opt-0');
      assert.equal(r.count, 1 + 3 + 11);
      await page.key('ArrowDown');
      assert.equal(await val(page, `dockInput.getAttribute('aria-activedescendant')`), 'mention-opt-1');
      await page.key('Enter');
      assert.equal(await val(page, `dockInput.value`), 'halo @product ');
      assert.equal(await val(page, `mentionList.hidden`), true);
      await page.type('@lea');
      await page.waitFor(`!mentionList.hidden`);
      await page.key('Escape');
      assert.equal(await val(page, `mentionList.hidden`), true);
      assert.equal(await val(page, `document.activeElement === dockInput`), true, 'Escape only closed the suggestions');
      assert.equal(await val(page, `dockInput.value`), 'halo @product @lea');
    },
  },
  {
    name: 'dock: the line under the input says who the prompt goes to, in the words of the design',
    async run(page) {
      await focusInput(page);
      await page.type('@eng');
      await page.key('Escape');
      assert.equal(await hint(page), 'Akan dikirim ke 4 agent Engineering');
      await val(page, `dockInput.value = '@lead-qa'; dockInput.dispatchEvent(new Event('input')); true`);
      await page.key('Escape');
      assert.equal(await hint(page), 'Akan dikirim ke Lead QA');
      await val(page, `dockInput.value = '@lead-qa @nobody'; dockInput.dispatchEvent(new Event('input')); true`);
      assert.match(await hint(page), /@nobody tidak dikenal/);
      await val(page, `dockInput.value = '@everyone'; dockInput.dispatchEvent(new Event('input')); true`);
      assert.equal(await hint(page), 'Akan dikirim ke semua 11 agent');
    },
  },
  {
    name: 'dock: sending nothing, or sending with no target, is refused with a message and the field marked invalid',
    async run(page) {
      await focusInput(page);
      await ctrlEnter(page);
      assert.equal(await hint(page), 'Tulis instruksi terlebih dahulu sebelum mengirim.');
      assert.equal(await val(page, `dockInput.getAttribute('aria-invalid')`), 'true');
      assert.equal(await val(page, `document.getElementById('dock-hint').dataset.kind`), 'error');
      await page.type('cek login');
      assert.equal(await val(page, `dockInput.getAttribute('aria-invalid')`), 'false', 'typing clears the error');
      await ctrlEnter(page);
      assert.equal(await hint(page), 'Pilih minimal 1 target: @agent atau @divisi.');
      assert.equal(await val(page, `taskStore.tasks.length`), 0);
    },
  },
  {
    name: 'dock: Ctrl+Enter sends; the dock locks while sending without moving, then confirms, clears and creates the task',
    async run(page) {
      await focusInput(page);
      await page.type('@lead-qa cek halaman login');
      const w0 = await val(page, `Math.round(dockSend.getBoundingClientRect().width)`);
      await ctrlEnter(page);
      const during = JSON.parse(await val(page, `JSON.stringify({ label: dockSend.textContent, disabled: dockSend.disabled, folder: document.getElementById('dock-folder').disabled, readOnly: dockInput.readOnly, w: Math.round(dockSend.getBoundingClientRect().width) })`));
      assert.deepEqual([during.label, during.disabled, during.folder, during.readOnly], ['Mengirim…', true, true, true]);
      assert.equal(during.w, w0, 'the button keeps its width');
      await page.waitFor(`!dock.sending`);
      assert.equal(await hint(page), 'Task dijalankan di alifgunadi-office dengan claude (simulasi)');
      assert.equal(await val(page, `dockInput.value`), '');
      assert.equal(await val(page, `taskStore.tasks.length`), 1);
      const d = await val(page, `JSON.stringify(deskMap.get('lead-qa'))`).then(JSON.parse);
      assert.equal(d.status, 'working');
      assert.equal(d.activity, '@lead-qa cek halaman login');
      assert.equal(await val(page, `document.getElementById('me-load').textContent`), 'Tugas aktif 1 / 1');
      await page.waitFor(`dock.success === ''`, 6000); // the success line goes away by itself
    },
  },
  {
    name: 'dock: a desk that is busy queues the next task behind it ("Posisi antrean"), and the filters follow the design rules',
    async run(page) {
      await sendPrompt(page, '@lead-qa pertama');
      await sendPrompt(page, '@lead-qa kedua');
      await showTasks(page);
      assert.equal(await val(page, `taskStore.tasks.map((t) => t.status).join()`), 'running,queued');
      assert.equal(await val(page, `OfficeTasks.counts(taskStore, 'lead-qa').queued`), 1);
      const cards = JSON.parse(await val(page, `JSON.stringify([...document.querySelectorAll('#task-list .task-card')].map((c) => c.querySelector('.badge').textContent + ' | ' + c.querySelector('.task-meta').textContent))`));
      assert.ok(cards.some((c) => c === 'Antre | Posisi antrean: 1 dari 1'), JSON.stringify(cards));
      assert.ok(cards.some((c) => c.startsWith('Berjalan')));
      assert.equal(await val(page, `document.getElementById('tasks-count').textContent`), '2');
      await val(page, `document.querySelector('[data-filter="active"]').click(); true`);
      assert.equal(await val(page, `document.querySelectorAll('#task-list .task-card').length`), 1);
      await val(page, `document.querySelector('[data-filter="waiting"]').click(); true`);
      assert.equal(await val(page, `document.querySelector('#task-list .badge').textContent`), 'Antre');
      await val(page, `document.querySelector('[data-filter="done"]').click(); true`);
      assert.match(await val(page, `document.getElementById('tasks-empty').textContent`), /Belum ada tugas yang selesai/);
    },
  },
  {
    name: 'dock: @everyone asks first ("semua 11 agent"), Batal sends nothing, "Kirim ke semua" creates 11 tasks',
    async run(page) {
      await focusInput(page);
      await page.type('@everyone tolong cek');
      await ctrlEnter(page);
      assert.equal(await val(page, `dockConfirm.hidden`), false);
      assert.equal(await val(page, `document.getElementById('dock-confirm-text').textContent`), 'Kirim tugas ini ke semua 11 agent?');
      assert.equal(await val(page, `document.activeElement.id`), 'confirm-send', 'focus goes to the confirmation');
      await val(page, `document.getElementById('confirm-cancel').click(); true`);
      assert.equal(await val(page, `taskStore.tasks.length`), 0);
      assert.equal(await val(page, `dockInput.value.length > 0`), true, 'the draft is kept');
      await ctrlEnter(page);
      await val(page, `document.getElementById('confirm-send').click(); true`);
      await page.waitFor(`taskStore.tasks.length === 11`, 4000);
      assert.equal(await val(page, `new Set(taskStore.tasks.map((t) => t.batchId)).size`), 1);
      assert.equal(await val(page, `taskStore.tasks.some((t) => t.deskId === 'main')`), false, 'never AlifGunadi');
    },
  },
  {
    name: 'dock: no connection disables sending and the menus, keeps the draft, and says so',
    async run(page) {
      await focusInput(page);
      await page.type('@lead-qa jangan hilang');
      await val(page, `onConnectionChange(false); true`);
      assert.equal(await hint(page), 'Menunggu koneksi server…');
      assert.equal(await val(page, `[dockSend.disabled, document.getElementById('dock-folder').disabled, document.getElementById('dock-runner').disabled].join()`), 'true,true,true');
      await ctrlEnter(page);
      assert.equal(await val(page, `taskStore.tasks.length`), 0, 'nothing is sent');
      assert.equal(await val(page, `dockInput.value`), '@lead-qa jangan hilang');
      await val(page, `onConnectionChange(true); true`);
      assert.equal(await val(page, `dockSend.disabled`), false);
      assert.equal(await hint(page), 'Akan dikirim ke Lead QA');
    },
  },
  {
    name: 'dock: cancel: a queued task goes at once, a running one asks first, and the next in line then starts',
    async run(page) {
      await sendPrompt(page, '@lead-qa satu');
      await sendPrompt(page, '@lead-qa dua');
      await showTasks(page);
      const act = (status, action) => val(page, `document.querySelector('.task-card[data-status="${status}"] [data-action="${action}"]').click(); true`);
      await act('running', 'cancel');
      assert.match(await val(page, `document.querySelector('.task-card[data-status="running"] .ask').textContent`), /Batalkan tugas yang berjalan\?/);
      await act('running', 'keep');
      assert.equal(await val(page, `taskStore.tasks[0].status`), 'running', '"Tidak" keeps it');
      await act('running', 'cancel');
      await act('running', 'confirm-cancel');
      assert.equal(await val(page, `taskStore.tasks.map((t) => t.status).join()`), 'cancelled,running', 'the queued task took over');
      await act('running', 'cancel');
      await act('running', 'confirm-cancel');
      assert.equal(await val(page, `taskStore.tasks.map((t) => t.status).join()`), 'cancelled,cancelled');
      assert.equal(await val(page, `document.getElementById('me-load').textContent`), 'Tugas aktif 0 / 0');
    },
  },
  {
    name: 'dock: a task that asks a question shows "Butuh Input"; Jawab opens the dock for it and the answer lets it go on',
    async run(page) {
      await sendPrompt(page, '@lead-security apakah scope boleh diperluas?');
      await val(page, `taskStore.tasks.forEach((t) => { t.startedAt -= 3500; }); true`); // let the simulated time pass
      await page.waitFor(`taskStore.tasks[0].status === 'waiting_input'`, 4000);
      const d = JSON.parse(await val(page, `JSON.stringify(deskMap.get('lead-security'))`));
      assert.equal(d.status, 'waiting');
      await showTasks(page);
      await page.waitFor(`document.querySelector('.task-card[data-status="waiting_input"] [data-action="answer"]')`);
      await val(page, `document.querySelector('[data-action="answer"]').click(); true`);
      assert.equal(await val(page, `dockWho.textContent`), 'Membalas Lead Security (@lead-security)');
      assert.equal(await val(page, `document.activeElement === dockInput`), true);
      await page.type('ya, boleh');
      await ctrlEnter(page);
      await page.waitFor(`!dock.sending && taskStore.tasks[0].status === 'running'`, 4000);
      assert.equal(await val(page, `taskStore.tasks.length`), 1, 'the answer did not make a second task');
      assert.match(await hint(page), /Balasan terkirim ke Lead Security/);
    },
  },
  {
    name: 'dock: clicking a desk opens the dock with that agent as a removable target and the field focused',
    async run(page) {
      await page.viewport(1440, 900, { reducedMotion: true });
      const f = await val(page, `deskFront(layout.byId.get('lead-qa'))`);
      const [cx, cy] = await val(page, `(() => { const r = canvas.getBoundingClientRect(), s = pj(${f[0]}, ${f[1]}, 0); return [r.left + s[0] * sc, r.top + s[1] * sc]; })()`);
      await page.click(cx, cy);
      await page.waitFor(`dock.chips.length === 1`, 8000);
      const r = JSON.parse(await val(page, `JSON.stringify({ state: dockEl.dataset.state, who: dockWho.textContent, chip: dockChips.textContent, ph: dockInput.placeholder, focus: document.activeElement === dockInput })`));
      assert.equal(r.state, 'expanded');
      assert.equal(r.who, 'Berbicara dengan Lead QA (@lead-qa)');
      assert.match(r.chip, /@lead-qa/);
      assert.equal(r.ph, 'Tulis arahan untuk Lead QA…');
      assert.equal(r.focus, true);
      await page.type('cek login');
      await ctrlEnter(page);
      await page.waitFor(`taskStore.tasks.length === 1 && taskStore.tasks[0].deskId === 'lead-qa'`, 4000);
      await val(page, `dock.chips = ['lead-ui']; renderChips(); true`);
      await val(page, `dockChips.querySelector('button').click(); true`);
      assert.equal(await val(page, `dock.chips.length`), 0, 'the chip can be removed');
    },
  },
  {
    name: 'dock: the Folder and Runner menus are listboxes with keyboard support; antigravity is shown as unavailable',
    async run(page) {
      await focusInput(page);
      await page.type('x');
      await val(page, `document.getElementById('dock-folder').click(); true`);
      const open = JSON.parse(await val(page, `JSON.stringify({ expanded: document.getElementById('dock-folder').getAttribute('aria-expanded'), opts: [...document.querySelectorAll('#folder-list [role=option]')].map((o) => o.textContent + ':' + o.getAttribute('aria-selected') + ':' + (o.getAttribute('aria-disabled') || '')), focus: document.activeElement.id })`));
      assert.equal(open.expanded, 'true');
      assert.deepEqual(open.opts, ['alifgunadi-office:true:', 'design-system:false:', 'api-gateway:false:', 'Ubah folder induk…:false:']);
      assert.equal(open.focus, 'folder-list');
      await page.key('ArrowDown');
      await page.key('Enter');
      assert.equal(await val(page, `document.getElementById('dock-folder-name').textContent`), 'design-system');
      assert.equal(await val(page, `document.activeElement.id`), 'dock-folder', 'focus returns to the button');
      assert.equal(await val(page, `document.getElementById('folder-list').hidden`), true);
      await val(page, `document.getElementById('dock-runner').click(); true`);
      const runners = JSON.parse(await val(page, `JSON.stringify([...document.querySelectorAll('#runner-list [role=option]')].map((o) => o.textContent + ':' + (o.getAttribute('aria-disabled') || '')))`));
      assert.deepEqual(runners, ['claude:', 'opencode:', 'antigravitytidak tersedia · CLI tidak ditemukan di PATH:true']);
      await page.key('End');
      await page.key('Enter');
      assert.equal(await val(page, `dock.runner`), 'claude', 'an unavailable runner cannot be picked');
      await page.key('Escape');
      assert.equal(await val(page, `document.getElementById('runner-list').hidden`), true);
      await val(page, `dockInput.value = ''; true`);
      await sendPrompt(page, '@lead-ui pilihan');
      assert.equal(await val(page, `taskStore.tasks[0].folder + '/' + taskStore.tasks[0].runner`), 'design-system/claude');
    },
  },
  {
    name: 'dock: the camera shortcuts stay quiet while typing in the dock',
    async run(page) {
      await focusInput(page);
      await page.key('e', { text: 'e' });
      await page.key('q', { text: 'q' });
      await page.key('+', { text: '+' });
      assert.equal(await val(page, `document.getElementById('camera-readout').textContent`), '0° · 100%');
    },
  },
  {
    name: 'dock: on a touch screen the dock controls are 44px, and the menu options too',
    async run(page) {
      await page.viewport(1440, 900, { touch: true });
      await focusInput(page);
      await page.type('x');
      const r = JSON.parse(await val(page, `JSON.stringify({ send: Math.round(dockSend.getBoundingClientRect().height), folder: Math.round(document.getElementById('dock-folder').getBoundingClientRect().height) })`));
      assert.deepEqual([r.send, r.folder], [44, 44]);
      await val(page, `document.getElementById('dock-folder').click(); true`);
      assert.equal(await val(page, `Math.round(document.querySelector('#folder-list [role=option]').getBoundingClientRect().height)`), 44);
      await page.viewport(1440, 900, { touch: false });
    },
  },
  {
    name: 'dock: hovering a task card highlights its desk on the floor, and the page stays free of errors',
    async run(page) {
      await sendPrompt(page, '@lead-dba satu');
      await showTasks(page);
      await val(page, `document.querySelector('.task-card').dispatchEvent(new MouseEvent('mouseenter')); true`);
      assert.equal(await val(page, `focusId`), 'lead-dba');
      await val(page, `document.querySelector('.task-card').dispatchEvent(new MouseEvent('mouseleave')); true`);
      assert.equal(await val(page, `focusId`), null);
    },
  },
  {
    name: 'dock: with several targets the text field keeps a usable width (the targets take their own line) and shows no scrollbar',
    async run(page) {
      await val(page, `dock.chips = ['lead-software-engineer', 'lead-ui', 'lead-dba', 'lead-devops']; renderChips(); setDockState('expanded'); true`);
      await page.sleep(300);
      const m = JSON.parse(await val(page, `JSON.stringify({ field: document.querySelector('.dock-field').getBoundingClientRect().width, ta: dockInput.getBoundingClientRect().height, scroll: dockInput.scrollHeight, client: dockInput.clientHeight, chipsTop: document.getElementById('dock-chips').getBoundingClientRect().top, fieldTop: document.querySelector('.dock-field').getBoundingClientRect().top })`));
      assert.ok(m.field >= 260, 'text field width ' + m.field);
      assert.ok(m.scroll <= m.client + 1, 'the placeholder fits without a scrollbar ' + JSON.stringify(m));
      assert.ok(m.fieldTop > m.chipsTop, 'the field is below the targets');
    },
  },
];
