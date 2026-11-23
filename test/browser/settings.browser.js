'use strict';
// The settings dialog (parent folder). This browser is a viewer here (the real-mode cases that log in run later), and the harness server
// has a fixed folder list, so the editing flow is driven against a stand-in for the page's api() while the server side has its own tests.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const isOpen = (page) => val(page, `document.getElementById('settings-dialog').open`);
const status = (page) => val(page, `document.getElementById('settings-status').textContent`);

// Pretend to be a logged-in page that talks to a server we script: replies is a function (method, url, body) -> { status, data }.
const stub = (page, source) => val(page, `(() => { window.__realApi = window.__realApi || api; window.__calls = []; session.authed = true; api = async (m, u, b) => { __calls.push([m, u, b]); return (${source})(m, u, b); }; return true; })()`);
const unstub = (page) => val(page, `(() => { if (window.__realApi) api = window.__realApi; session.authed = false; session.workspaces = []; return true; })()`);

module.exports = [
  {
    name: 'settings: the gear opens a labelled dialog, Escape closes it and focus goes back to the gear',
    async run(page) {
      assert.equal(await val(page, `document.getElementById('btn-settings').getAttribute('aria-label')`), 'Pengaturan');
      await val(page, `document.getElementById('btn-settings').focus(); true`);
      await page.key('Enter', { text: '\r' }); // the gear opens its menu; its first entry is Folder induk
      await page.waitFor(`document.activeElement.id === 'gear-folder'`);
      await page.key('Enter', { text: '\r' });
      await page.waitFor(`document.getElementById('settings-dialog').open`);
      assert.equal(await val(page, `document.getElementById('settings-dialog').getAttribute('aria-labelledby')`), 'settings-title');
      assert.equal(await val(page, `document.getElementById('settings-close').getAttribute('aria-label')`), 'Tutup pengaturan');
      await page.key('Escape');
      await page.waitFor(`!document.getElementById('settings-dialog').open`);
      await page.waitFor(`document.activeElement.id === 'btn-settings'`, 3000); // the dialog hands focus back a moment after it closes
    },
  },
  {
    name: 'settings: as a viewer the folder cannot be edited and the dialog says how to log in',
    async run(page) {
      await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
      await page.waitFor(`document.getElementById('settings-dialog').open`);
      await page.waitFor(`document.getElementById('settings-status').textContent !== ''`);
      assert.equal(await val(page, `document.getElementById('settings-root').disabled`), true);
      assert.equal(await val(page, `document.getElementById('settings-save').disabled`), true);
      assert.match(await status(page), /start-office\.ps1|aplikasi desktop/);
      await val(page, `document.getElementById('settings-cancel').click(); true`);
      assert.equal(await isOpen(page), false);
    },
  },
  {
    name: 'settings: the dock menu offers "Ubah folder induk…" and it opens the dialog from the menu, returning focus to the Folder button',
    async run(page) {
      await val(page, `setDockState('expanded'); document.getElementById('dock-folder').click(); true`);
      await page.waitFor(`!document.getElementById('folder-list').hidden`);
      assert.equal(await val(page, `document.getElementById('folder-opt-settings').getAttribute('aria-disabled')`), null);
      await val(page, `document.getElementById('folder-opt-settings').click(); true`);
      await page.waitFor(`document.getElementById('settings-dialog').open`);
      assert.equal(await val(page, `document.getElementById('folder-list').hidden`), true);
      await page.key('Escape');
      await page.waitFor(`!document.getElementById('settings-dialog').open`);
      await page.waitFor(`document.activeElement.id === 'dock-folder'`, 3000);
    },
  },
  {
    name: 'settings: typing checks the folder after a pause, Save stays off until it is valid, an error is announced and marks the field',
    async run(page) {
      await stub(page, `(m, u, b) => {
        if (m === 'GET' && u === '/settings') return { status: 200, data: { root: { source: 'default', locked: false, root: 'C:\\\\projects', error: null, count: 4 } } };
        if (u === '/settings/check') return b.path === 'D:\\\\work' ? { status: 200, data: { ok: true, count: 7 } } : { status: 422, data: { ok: false, error: b.path === 'C:\\\\' ? 'too_broad' : 'not_found' } };
        return { status: 404, data: null };
      }`);
      try {
        await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
        await page.waitFor(`document.getElementById('settings-root').value === 'C:\\\\projects'`);
        assert.match(await status(page), /4 folder ditemukan/);
        assert.equal(await val(page, `document.getElementById('settings-save').disabled`), true, 'nothing changed yet');
        assert.equal(await val(page, `document.getElementById('settings-reset').disabled`), true, 'already the default');
        assert.match(await val(page, `document.getElementById('settings-source').textContent`), /Bawaan/);

        await val(page, `document.getElementById('settings-root').select(); true`);
        await page.type('C:\\');
        await page.waitFor(`document.getElementById('settings-status').dataset.kind === 'error'`);
        assert.match(await status(page), /terlalu luas/);
        assert.equal(await val(page, `document.getElementById('settings-root').getAttribute('aria-invalid')`), 'true');
        assert.equal(await val(page, `document.getElementById('settings-save').disabled`), true);

        await val(page, `document.getElementById('settings-root').select(); true`);
        await page.type('D:\\work');
        await page.waitFor(`document.getElementById('settings-status').dataset.kind === 'ok'`);
        assert.match(await status(page), /7 folder ditemukan/);
        assert.equal(await val(page, `document.getElementById('settings-root').getAttribute('aria-invalid')`), 'false');
        assert.equal(await val(page, `document.getElementById('settings-save').disabled`), false);

        await val(page, `document.getElementById('settings-root').select(); true`);
        await page.type('D:\\nope');
        await page.waitFor(`document.getElementById('settings-status').dataset.kind === 'error'`);
        assert.match(await status(page), /tidak ditemukan/);
        assert.equal(await val(page, `document.getElementById('settings-save').disabled`), true, 'a changed value is checked again');
      } finally {
        await val(page, `closeSettings(); true`);
        await unstub(page);
      }
    },
  },
  {
    name: 'settings: saving sends the path in a POST body, updates the folder list and the dock, and shows a toast',
    async run(page) {
      await stub(page, `(m, u, b) => {
        if (m === 'GET' && u === '/settings') return { status: 200, data: { root: { source: 'default', locked: false, root: 'C:\\\\projects', error: null, count: 4 } } };
        if (u === '/settings/check') return { status: 200, data: { ok: true, count: 2 } };
        if (u === '/settings/root') return { status: 200, data: { ok: true, root: { source: 'ui', locked: false, root: b.path, error: null, count: 2 }, workspaces: [{ id: 'zeta', label: 'zeta' }, { id: 'omega', label: 'omega' }] } };
        return { status: 404, data: null };
      }`);
      try {
        await val(page, `session.real = true; dock.folder = 'old'; document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
        await page.waitFor(`document.getElementById('settings-root').value === 'C:\\\\projects'`);
        await val(page, `document.getElementById('settings-root').select(); true`);
        await page.type('D:\\apps');
        await page.waitFor(`!document.getElementById('settings-save').disabled`);
        await page.key('Enter', { text: '\r' });
        await page.waitFor(`!document.getElementById('settings-dialog').open`);
        assert.deepEqual(await val(page, `__calls.filter((c) => c[1] === '/settings/root')`), [['POST', '/settings/root', { path: 'D:\\apps' }]]);
        assert.equal(await val(page, `session.workspaces.length`), 2);
        assert.equal(await val(page, `dock.folder`), 'zeta', 'the old choice is gone, so the first folder is taken');
        assert.equal(await val(page, `document.getElementById('dock-folder-name').textContent`), 'zeta');
        assert.match(await val(page, `document.getElementById('toast').textContent`), /disimpan: 2 folder/);
      } finally {
        await val(page, `session.real = false; dock.folder = FOLDERS[0]; document.getElementById('dock-folder-name').textContent = dock.folder; true`);
        await unstub(page);
      }
    },
  },
  {
    name: 'settings: a refused save keeps the dialog open with the reason; "Kembalikan ke bawaan" sends null and is only on when the folder was chosen here',
    async run(page) {
      await stub(page, `(m, u, b) => {
        if (m === 'GET' && u === '/settings') return { status: 200, data: { root: { source: 'ui', locked: false, root: 'D:\\\\apps', error: null, count: 2 } } };
        if (u === '/settings/check') return { status: 200, data: { ok: true, count: 1 } };
        if (u === '/settings/root' && b.path !== null) return { status: 500, data: { ok: false, error: 'not_saved' } };
        if (u === '/settings/root') return { status: 200, data: { ok: true, root: { source: 'default', locked: false, root: 'C:\\\\projects', error: null, count: 4 }, workspaces: [] } };
        return { status: 404, data: null };
      }`);
      try {
        await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
        await page.waitFor(`document.getElementById('settings-root').value === 'D:\\\\apps'`);
        assert.equal(await val(page, `document.getElementById('settings-reset').disabled`), false);
        await val(page, `document.getElementById('settings-root').select(); true`);
        await page.type('E:\\x');
        await page.waitFor(`!document.getElementById('settings-save').disabled`);
        await val(page, `document.getElementById('settings-save').click(); true`);
        await page.waitFor(`document.getElementById('settings-status').dataset.kind === 'error'`);
        assert.match(await status(page), /tidak bisa disimpan/);
        assert.equal(await isOpen(page), true);
        await val(page, `document.getElementById('settings-reset').click(); true`);
        await page.waitFor(`!document.getElementById('settings-dialog').open`);
        assert.deepEqual(await val(page, `__calls.filter((c) => c[1] === '/settings/root').pop()`), ['POST', '/settings/root', { path: null }]);
      } finally {
        await val(page, `closeSettings(); true`);
        await unstub(page);
      }
    },
  },
  {
    name: 'settings: a locked server (fixed list) shows the reason and cannot be edited',
    async run(page) {
      await stub(page, `(m, u) => (u === '/settings' ? { status: 200, data: { root: { source: 'fixed', locked: true, root: null, error: null, count: 3 } } } : { status: 404, data: null })`);
      try {
        await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
        await page.waitFor(`document.getElementById('settings-status').textContent.includes('dikunci')`);
        assert.equal(await val(page, `document.getElementById('settings-root').disabled`), true);
        assert.equal(await val(page, `document.getElementById('settings-save').disabled`), true);
        assert.equal(await val(page, `document.getElementById('settings-reset').disabled`), true);
        assert.match(await status(page), /3 folder tersedia/);
      } finally {
        await val(page, `closeSettings(); true`);
        await unstub(page);
      }
    },
  },
  {
    name: 'settings: the dialog fits a phone-sized window with its buttons reachable',
    async run(page) {
      await page.viewport(390, 700);
      await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
      await page.waitFor(`document.getElementById('settings-dialog').open`);
      const r = await val(page, `(() => { const b = document.getElementById('settings-dialog').getBoundingClientRect(); return { l: b.left, r: b.right, w: innerWidth, hs: document.documentElement.scrollWidth }; })()`);
      assert.ok(r.l >= 0 && r.r <= r.w, JSON.stringify(r));
      assert.ok(r.hs <= r.w, 'no horizontal scroll');
      for (const id of ['settings-save', 'settings-cancel', 'settings-close']) {
        const b = await val(page, `(() => { const e = document.getElementById('${id}').getBoundingClientRect(); return { l: e.left, r: e.right, t: e.top, b: e.bottom, w: innerWidth, h: innerHeight }; })()`);
        assert.ok(b.l >= 0 && b.r <= b.w && b.t >= 0 && b.b <= b.h, id + ' ' + JSON.stringify(b));
      }
      await val(page, `closeSettings(); true`);
    },
  },
];
