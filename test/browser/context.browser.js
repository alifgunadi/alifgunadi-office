'use strict';
// Context from links in the dock (Jira, Figma, Penpot): chips under the input and the Konteks tab. The page's api() is replaced by a
// stand-in (the server side has its own tests), and the page is made to believe it is in real mode.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const JIRA = 'https://acme.atlassian.net/browse/ABC-1';

const stub = (page, source) => val(page, `(() => {
  window.__realApi = window.__realApi || api; window.__realLeave = window.__realLeave || leaveRealMode; leaveRealMode = () => {}; /* the page's own stream is not logged in */ window.__calls = [];
  session.authed = true; session.real = true; session.workspaces = [{ id: 'w', label: 'w' }]; session.runners = [{ id: 'claude', ok: true, why: '' }];
  dock.folder = 'w'; dock.runner = 'claude'; trustedFolders.add('w'); /* these cases are about links, not about trusting the folder */
  api = async (m, u, b) => { __calls.push([m, u, b]); return (${source})(m, u, b); };
  onContextMode(); return true; })()`);
const unstub = (page) => val(page, `(() => { trustedFolders.clear(); if (window.__realApi) api = window.__realApi; if (window.__realLeave) leaveRealMode = window.__realLeave; session.authed = false; session.real = false; session.workspaces = []; session.runners = []; dock.folder = FOLDERS[0]; dock.runner = 'claude'; document.getElementById('dock-folder-name').textContent = dock.folder; document.getElementById('dock-runner-name').textContent = dock.runner; onContextMode(); dockInput.value = ''; renderContext(); return true; })()`);
const setText = async (page, text) => {
  await val(page, `dockInput.focus(); dockInput.value = ${JSON.stringify(text)}; dockInput.dispatchEvent(new Event('input', { bubbles: true })); true`);
};
const chips = (page) => val(page, `[...document.querySelectorAll('#context-chips .context-label')].map((e) => e.textContent)`);

const RESOLVE = `(m, u, b) => {
  if (u === '/integrations/resolve') return { status: 200, data: { results: b.urls.map((x) => x.includes('atlassian') ? { url: x, provider: 'jira', label: 'ABC-1', resolved: true, title: 'Fix the login', status: 'In Progress', kind: 'Bug', key: 'ABC-1' } : x.includes('figma') ? { url: x, provider: 'figma', label: 'Figma AbCdEf', resolved: false, reason: 'missing_credentials' } : { url: x, resolved: false, reason: 'unsupported' }) } };
  if (u === '/prompts') return { status: 202, data: { batchId: 'b1', tasks: ['t1'], rejected: [], context: true } };
  return { status: 404, data: null };
}`;

module.exports = [
  {
    name: 'context: a viewer (simulation) gets no chips and no Konteks tab, whatever is pasted',
    async run(page) {
      await setText(page, 'lihat ' + JIRA);
      await page.sleep(900);
      assert.equal(await val(page, `document.getElementById('tab-context').hidden`), true);
      assert.equal(await val(page, `document.getElementById('context-chips').hidden`), true);
      assert.equal(await val(page, `linkCtx.items.size`), 0);
      await val(page, `dockInput.value = ''; true`);
    },
  },
  {
    name: 'context: a Jira link becomes a chip after a pause, other links are ignored, and a provider without a token says so',
    async run(page) {
      await stub(page, RESOLVE);
      try {
        await setText(page, 'lihat ' + JIRA + ', dan https://evil.example/x serta https://www.figma.com/file/AbCdEfGhIjKlMn/x.');
        try { await page.waitFor(`document.querySelectorAll('#context-chips .context-chip').length === 2`, 4000); } catch (e) { throw new Error(e.message + ' :: ' + JSON.stringify(await val(page, `({ chips: [...document.querySelectorAll('#context-chips .context-label')].map((x) => x.textContent), items: [...linkCtx.items.values()].map((x) => x.state), real: realMode(), text: dockInput.value, calls: __calls.length })`))); }
        assert.deepEqual(await chips(page), ['Jira · Fix the login', 'Figma · token belum diatur di server']);
        assert.equal(await val(page, `document.querySelector('#context-chips .context-chip.is-error') !== null`), true);
        // one call, with the three links as typed (no trailing comma or full stop)
        const calls = await val(page, `__calls.filter((c) => c[1] === '/integrations/resolve')`);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0][2].urls, [JIRA, 'https://evil.example/x', 'https://www.figma.com/file/AbCdEfGhIjKlMn/x']);
        // the tab
        assert.equal(await val(page, `document.getElementById('tab-context').hidden`), false);
        assert.equal(await val(page, `document.getElementById('context-count').textContent`), '2');
        await val(page, `selectTab(document.getElementById('tab-context'), false); true`);
        const text = await val(page, `document.getElementById('panel-context').textContent`);
        assert.match(text, /Fix the login/);
        assert.match(text, /Bug · In Progress/);
        assert.match(text, /https:\/\/acme\.atlassian\.net\/browse\/ABC-1/);
        assert.equal(await val(page, `document.getElementById('context-empty').hidden`), true);
        await val(page, `selectTab(tabButtons[1], false); true`);
      } finally { await unstub(page); }
    },
  },
  {
    name: 'context: "Gunakan sebagai URL" takes the link off the attachment, and a link taken out of the text disappears',
    async run(page) {
      await stub(page, RESOLVE);
      try {
        await setText(page, 'lihat ' + JIRA);
        await page.waitFor(`document.querySelectorAll('#context-chips .context-chip').length === 1`, 4000);
        assert.deepEqual(await val(page, `contextUrlsToSend()`), [JIRA]);
        assert.match(await val(page, `document.querySelector('.context-off').getAttribute('aria-label')`), /Gunakan sebagai URL saja: Jira ABC-1/);
        await val(page, `document.querySelector('.context-off').click(); true`);
        assert.equal(await val(page, `document.querySelectorAll('#context-chips .context-chip').length`), 0);
        assert.deepEqual(await val(page, `contextUrlsToSend()`), []);
        assert.equal(await val(page, `dockInput.value`), 'lihat ' + JIRA, 'the link stays in the text');
        assert.equal(await val(page, `document.activeElement === dockInput`), true);
        // out of the text, and back in: it counts as new
        await setText(page, 'tanpa tautan');
        await page.sleep(900);
        assert.equal(await val(page, `linkCtx.items.size + linkCtx.excluded.size`), 0);
        await setText(page, JIRA);
        await page.waitFor(`document.querySelectorAll('#context-chips .context-chip').length === 1`, 4000);
      } finally { await unstub(page); }
    },
  },
  {
    name: 'context: sending puts the links that are still attached in the request, and the chips are cleared afterwards',
    async run(page) {
      await stub(page, RESOLVE);
      try {
        await setText(page, 'kerjakan @lead-qa ' + JIRA + ' https://www.figma.com/file/AbCdEfGhIjKlMn/x');
        await page.waitFor(`document.querySelectorAll('#context-chips .context-chip').length === 2`, 4000);
        await val(page, `document.querySelectorAll('.context-off')[1].click(); true`); // the Figma one is taken off
        await page.key('Enter', { modifiers: 2 });
        await page.waitFor(`__calls.some((c) => c[1] === '/prompts')`, 4000);
        const body = await val(page, `__calls.find((c) => c[1] === '/prompts')[2]`);
        assert.deepEqual(body.urls, [JIRA]);
        assert.equal(body.workspaceId, 'w');
        assert.match(body.text, /kerjakan @lead-qa/);
        await page.waitFor(`!dock.sending && dock.success !== ''`, 4000);
        assert.equal(await val(page, `document.querySelectorAll('#context-chips .context-chip').length`), 0);
        assert.equal(await val(page, `linkCtx.items.size`), 0);
      } finally { await unstub(page); }
    },
  },
  {
    name: 'context: a prompt without links sends no "urls", and text that looks like markup is shown as text',
    async run(page) {
      await stub(page, `(m, u, b) => {
        if (u === '/integrations/resolve') return { status: 200, data: { results: b.urls.map((x) => ({ url: x, provider: 'jira', label: 'ABC-1', resolved: true, title: '<img src=x onerror=window.__pwn=1>', status: '<b>x</b>', kind: 'Bug' })) } };
        return { status: 202, data: { batchId: 'b1', tasks: ['t1'], rejected: [] } };
      }`);
      try {
        await setText(page, 'cukup teks @lead-qa');
        await page.key('Enter', { modifiers: 2 });
        await page.waitFor(`__calls.some((c) => c[1] === '/prompts')`, 4000);
        assert.equal(await val(page, `__calls.find((c) => c[1] === '/prompts')[2].urls`), undefined);
        await page.waitFor(`!dock.sending`, 4000);
        await setText(page, JIRA);
        await page.waitFor(`document.querySelectorAll('#context-chips .context-chip').length === 1`, 4000);
        assert.equal(await val(page, `window.__pwn`), undefined);
        assert.equal(await val(page, `document.querySelectorAll('#context-chips img, #context-list img, #context-list b').length`), 0);
        assert.match((await chips(page))[0], /<img src=x/);
      } finally { await unstub(page); }
    },
  },
  {
    name: 'context: the server being unreachable, or answering badly, shows an error chip and does not block sending',
    async run(page) {
      await stub(page, `(m, u) => (u === '/integrations/resolve' ? { status: 0, data: null } : { status: 202, data: { batchId: 'b1', tasks: ['t1'], rejected: [] } })`);
      try {
        await setText(page, '@lead-qa ' + JIRA);
        await page.waitFor(`document.querySelectorAll('#context-chips .context-chip.is-error').length === 1`, 4000);
        assert.match((await chips(page))[0], /gagal dibaca/);
        await page.key('Enter', { modifiers: 2 });
        await page.waitFor(`__calls.some((c) => c[1] === '/prompts')`, 4000);
      } finally { await unstub(page); }
    },
  },
  {
    name: 'context: arrow keys move over the visible tabs only (the Konteks tab exists in real mode)',
    async run(page) {
      assert.equal(await val(page, `visibleTabs().length`), 2);
      await stub(page, RESOLVE);
      try {
        assert.equal(await val(page, `visibleTabs().length`), 3);
        await val(page, `selectTab(tabButtons[1], true); true`);
        await page.key('ArrowRight');
        assert.equal(await val(page, `document.activeElement.id`), 'tab-context');
        await page.key('ArrowRight');
        assert.equal(await val(page, `document.activeElement.id`), 'tab-tasks');
      } finally { await unstub(page); }
      assert.equal(await val(page, `visibleTabs().length`), 2);
      await val(page, `selectTab(tabButtons[1], false); true`);
      await page.key('Home');
    },
  },
];
