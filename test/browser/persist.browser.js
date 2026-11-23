'use strict';
// What survives a reload of the page: the text being typed, the Folder and the Runner (kept in this browser only).

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const KEY = 'alifgunadi-office.dock';
const reload = async (page) => { await page.open(page.origin + '/'); await page.waitFor(`typeof dock !== 'undefined' && document.getElementById('conn').textContent === 'live'`); };
const clear = (page) => val(page, `try { localStorage.removeItem('${KEY}'); } catch (e) {} true`);

module.exports = [
  {
    name: 'persistence: the draft and the Folder come back after a reload',
    async run(page) {
      try {
        await val(page, `dockInput.focus(); true`);
        await page.type('halo @lead-qa kerjakan ini');
        await val(page, `document.getElementById('dock-folder').click(); true`);
        await page.waitFor(`!document.getElementById('folder-list').hidden`);
        await val(page, `[...document.querySelectorAll('#folder-list [role=option]')].find((o) => o.textContent === 'design-system').click(); true`);
        await page.sleep(600); // the draft is saved a moment after typing stops
        const saved = JSON.parse(await val(page, `localStorage.getItem('${KEY}')`));
        assert.deepEqual(saved, { folder: 'design-system', runner: 'claude', draft: 'halo @lead-qa kerjakan ini' });
        await reload(page);
        assert.equal(await val(page, `dockInput.value`), 'halo @lead-qa kerjakan ini');
        assert.equal(await val(page, `dock.folder`), 'design-system');
        assert.equal(await val(page, `document.getElementById('dock-folder-name').textContent`), 'design-system');
      } finally { await clear(page); }
    },
  },
  {
    name: 'persistence: sending clears the saved draft but keeps the choices',
    async run(page) {
      try {
        await val(page, `dockInput.focus(); true`);
        await page.type('halo @lead-qa');
        await page.sleep(600);
        await page.key('Enter', { modifiers: 2 });
        await page.waitFor(`!dock.sending && dock.success !== ''`, 5000);
        const saved = JSON.parse(await val(page, `localStorage.getItem('${KEY}')`));
        assert.equal(saved.draft, '');
        assert.equal(saved.folder, await val(page, 'dock.folder'));
        await reload(page);
        assert.equal(await val(page, `dockInput.value`), '');
      } finally { await clear(page); }
    },
  },
  {
    name: 'persistence: saved values that are damaged, too big or no longer on offer fall back to the defaults',
    async run(page) {
      try {
        for (const junk of ['{oops', 'null', '[]', '"x"', JSON.stringify({ folder: 5, runner: {}, draft: [] }), JSON.stringify({ folder: 'gone', runner: 'nope', draft: '' })]) {
          await val(page, `localStorage.setItem('${KEY}', ${JSON.stringify(junk)}); true`);
          await reload(page);
          assert.equal(await val(page, `dock.folder`), 'alifgunadi-office', junk);
          assert.equal(await val(page, `dock.runner`), 'claude', junk);
          assert.equal(await val(page, `dockInput.value`), '', junk);
        }
        await val(page, `localStorage.setItem('${KEY}', JSON.stringify({ folder: 'alifgunadi-office', runner: 'claude', draft: 'x'.repeat(50000) })); true`);
        await reload(page);
        assert.equal(await val(page, `dockInput.value.length`), 4000, 'a draft is never longer than a prompt may be');
      } finally { await clear(page); }
    },
  },
  {
    name: 'persistence: a draft is shown as text, never as markup',
    async run(page) {
      try {
        await val(page, `localStorage.setItem('${KEY}', JSON.stringify({ folder: 'alifgunadi-office', runner: 'claude', draft: '<img src=x onerror=window.__pwn=1> @lead-qa' })); true`);
        await reload(page);
        assert.equal(await val(page, `window.__pwn`), undefined);
        assert.match(await val(page, `dockInput.value`), /<img src=x/);
      } finally { await clear(page); }
    },
  },
];
