'use strict';
// Tablet and phone layouts (Phase J): where the panels sit, the sheet, the menu, the desk chip, the camera bar, touch targets, overflow.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const rect = (page, sel) => val(page, `(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const phone = (page) => page.viewport(390, 800, { touch: true });
const tablet = (page) => page.viewport(1024, 768, { touch: true });
const back = async (page) => {
  await val(page, `setUserReduce(false); try { localStorage.removeItem(MOTION_KEY); } catch (e) {} true`);
  await page.viewport(1440, 900, { touch: false });
};
const noOverflow = async (page, label) => {
  const m = await val(page, `({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth })`);
  assert.ok(m.sw <= m.iw && m.bw <= m.iw, label + ' horizontal overflow ' + JSON.stringify(m));
};

module.exports = [
  {
    name: 'responsive: no horizontal overflow at 390, 768, 1024, 1100 and 1440',
    async run(page) {
      try {
        for (const [w, h] of [[390, 800], [768, 1024], [1024, 768], [1100, 800], [1440, 900]]) {
          await page.viewport(w, h, { touch: w < 1000 });
          await noOverflow(page, w + 'px');
        }
      } finally { await back(page); }
    },
  },
  {
    name: 'responsive: tablet (1024) puts the panel below a wide stage, with a one-line camera bar of 52px and no minimap',
    async run(page) {
      try {
        await tablet(page);
        await page.waitFor(`layout.cols === 0`);
        const stage = await rect(page, '.stage-wrap'), aside = await rect(page, 'aside'), cam = await rect(page, '#camera');
        assert.ok(aside.t >= stage.b - 1, 'the panel is below the stage ' + JSON.stringify({ stage, aside }));
        assert.ok(aside.w >= 1000, 'the panel is as wide as the page');
        assert.ok(Math.abs(cam.h - 52) <= 1, 'camera bar height ' + cam.h);
        assert.equal(await val(page, `getComputedStyle(document.querySelector('.minimap-card')).display`), 'none');
        assert.equal(await val(page, `getComputedStyle(document.getElementById('menu-pop')).display`), 'none');
        assert.equal(await val(page, `getComputedStyle(document.querySelector('.menu-wrap')).display`), 'none', 'the hamburger is for phones');
        const dk = await rect(page, '#dock'), st = await rect(page, '.stage');
        assert.ok(dk.t >= st.b - 1, 'the dock is below the stage ' + JSON.stringify({ dk, st }));
        assert.equal(await val(page, `document.getElementById('cam-walls-cycle').textContent`), 'Dinding: Potong');
        // the camera still turns and zooms
        await val(page, `document.getElementById('cam-right').click(); true`);
        assert.equal(await val(page, `camera.rot`), 1);
        await val(page, `document.getElementById('cam-left').click(); true`);
      } finally { await back(page); }
    },
  },
  {
    name: 'responsive: tablet task cards scroll sideways and "n / total" follows the scroll (announced politely)',
    async run(page) {
      try {
        await tablet(page);
        await val(page, `selectTab(tabButtons[0], false); true`);
        await val(page, `(() => { OfficeTasks.enqueue(taskStore, { text: 'tugas', targets: ['lead-qa','lead-ui','lead-dba','lead-swe','lead-devops','lead-security'], folder: 'f', runner: 'claude' }, Date.now()); tasksChanged(); return true; })()`);
        await page.waitFor(`document.querySelectorAll('.task-card').length === 6`);
        await page.waitFor(`document.getElementById('task-pos').textContent === '1 / 6'`);
        assert.equal(await val(page, `document.getElementById('task-pos').getAttribute('aria-live')`), 'polite');
        const m = await val(page, `({ sw: taskListEl.scrollWidth, cw: taskListEl.clientWidth, dir: getComputedStyle(taskListEl).flexDirection })`);
        assert.equal(m.dir, 'row');
        assert.ok(m.sw > m.cw, 'the cards overflow sideways ' + JSON.stringify(m));
        await val(page, `taskListEl.scrollLeft = taskListEl.scrollWidth; true`);
        await page.waitFor(`document.getElementById('task-pos').textContent === '6 / 6'`);
      } finally { await back(page); }
    },
  },
  {
    name: 'responsive: phone keeps the page one screen, the panel is a sheet that opens by the grabber, by a tab and closes with Escape',
    async run(page) {
      try {
        await phone(page);
        await page.waitFor(`layout.cols === 0`);
        const peek = await rect(page, 'aside');
        assert.ok(peek.t >= 800 - 251 && peek.t <= 800 - 249, 'a peek of about 250px (grabber, tabs, the first card and a hint) ' + JSON.stringify(peek));
        assert.equal(await val(page, `document.getElementById('sheet-toggle').getAttribute('aria-expanded')`), 'false');
        // closed: the filters are not shown, only the tabs, the first card and a hint
        assert.equal(await val(page, `getComputedStyle(document.querySelector('.filters')).display`), 'none');
        await val(page, `document.getElementById('sheet-toggle').click(); true`);
        await page.sleep(400);
        const open = await rect(page, 'aside');
        assert.ok(open.h > 300 && open.t < 800 - 300, 'opened ' + JSON.stringify(open));
        assert.equal(await val(page, `getComputedStyle(document.querySelector('.filters')).display`), 'flex');
        await val(page, `document.getElementById('tab-tasks').focus(); true`);
        await page.key('Escape');
        await page.waitFor(`!document.getElementById('side-panel').classList.contains('is-open')`);
        assert.equal(await val(page, `document.activeElement.id`), 'sheet-toggle');
        await val(page, `document.getElementById('tab-tasks').click(); true`);
        await page.waitFor(`document.getElementById('side-panel').classList.contains('is-open')`);
        await page.viewport(1440, 900, { touch: false });
        await page.waitFor(`!document.getElementById('side-panel').classList.contains('is-open')`);
      } finally { await back(page); }
    },
  },
  {
    name: 'responsive: phone keeps the gear (Restart and Stop live in its menu, Stop asks first) and a menu with the rest; the motion choice is remembered',
    async run(page) {
      try {
        await phone(page);
        assert.equal(await val(page, `getComputedStyle(document.querySelector('.topbar .controls')).display`), 'flex', 'the gear stays in the bar');
        const gear = await rect(page, '#btn-settings');
        assert.ok(gear.w >= 44 && gear.h >= 44, 'gear size ' + JSON.stringify(gear));
        const btn = await rect(page, '#btn-menu');
        assert.ok(btn.w >= 44 && btn.h >= 44, 'menu button size ' + JSON.stringify(btn));
        await val(page, `document.getElementById('btn-menu').click(); true`);
        assert.equal(await val(page, `document.getElementById('btn-menu').getAttribute('aria-expanded')`), 'true');
        assert.deepEqual(await val(page, `[...document.querySelectorAll('#menu-pop .menu-item')].map((b) => b.textContent)`), ['Folder & Runner', 'Gerak berkurang', 'Tentang'], 'Settings, Restart and Stop are in the gear menu, not here');
        assert.equal(await val(page, `document.activeElement.textContent`), 'Folder & Runner');
        await page.key('ArrowDown');
        assert.equal(await val(page, `document.activeElement.textContent`), 'Gerak berkurang');
        // the gear menu: Stop asks first, and Batal comes back to the menu without stopping anything
        await val(page, `document.getElementById('btn-menu').click(); window.__stopped = 0; window.__stop = stopServer; stopServer = async () => { window.__stopped++; }; document.getElementById('btn-settings').click(); document.getElementById('btn-stop').click(); true`);
        assert.match(await val(page, `document.querySelector('#gear-pop .confirm-row').textContent`), /Hentikan server/);
        assert.equal(await val(page, `document.getElementById('gear-pop').hidden`), false);
        await val(page, `document.querySelector('#gear-pop .confirm-row .btn--secondary').click(); true`);
        assert.equal(await val(page, `window.__stopped`), 0);
        assert.equal(await val(page, `document.querySelectorAll('#gear-pop [role=menuitem]').length`), 3);
        await val(page, `document.getElementById('btn-stop').click(); document.querySelector('#gear-pop .confirm-row .btn--danger').click(); true`);
        assert.equal(await val(page, `window.__stopped`), 1, 'Stop after the confirmation');
        await val(page, `stopServer = window.__stop; true`);
        assert.equal(await val(page, `document.getElementById('gear-pop').hidden`), true);
        await val(page, `document.getElementById('btn-menu').click(); true`);
        // reduced motion on the page
        await val(page, `[...document.querySelectorAll('#menu-pop .menu-item')].find((b) => b.textContent === 'Gerak berkurang').click(); true`);
        assert.equal(await val(page, `document.documentElement.classList.contains('reduce-motion') && reduced === true && localStorage.getItem(MOTION_KEY)`), '1');
        assert.equal(await val(page, `document.querySelector('#menu-pop [aria-checked]').getAttribute('aria-checked')`), 'true');
        await page.key('Escape');
        assert.equal(await val(page, `document.getElementById('menu-pop').hidden`), true);
        assert.equal(await val(page, `document.activeElement.id`), 'btn-menu');
        // Folder induk opens the dialog from the gear menu
        await val(page, `document.getElementById('btn-settings').click(); document.getElementById('gear-folder').click(); true`);
        await page.waitFor(`document.getElementById('settings-dialog').open`);
        await val(page, `closeSettings(); true`);
        // Tentang
        await val(page, `document.getElementById('btn-menu').click(); [...document.querySelectorAll('#menu-pop .menu-item')].find((b) => b.textContent === 'Tentang').click(); true`);
        await page.waitFor(`document.getElementById('about-dialog').open`);
        await page.key('Escape');
        await page.waitFor(`!document.getElementById('about-dialog').open`);
      } finally { await back(page); }
    },
  },
  {
    name: 'responsive: phone folds the zone legend into one chip and picks a desk from "Fokus ke meja"',
    async run(page) {
      try {
        await phone(page);
        await page.waitFor(`layout.cols === 0`);
        assert.equal(await val(page, `getComputedStyle(document.getElementById('legend')).display`), 'none');
        const chip = await rect(page, '#legend-toggle');
        assert.ok(chip.h >= 44, 'legend chip height ' + chip.h);
        await val(page, `document.getElementById('legend-toggle').click(); true`);
        assert.equal(await val(page, `getComputedStyle(document.getElementById('legend')).display`), 'flex');
        assert.equal(await val(page, `document.getElementById('legend-toggle').getAttribute('aria-expanded')`), 'true');
        assert.equal(await val(page, `document.querySelectorAll('#legend .zone-chip').length`), 5);
        await val(page, `document.getElementById('legend-toggle').click(); true`);
        assert.equal(await val(page, `getComputedStyle(document.getElementById('legend')).display`), 'none');
        // "Fokus ke meja": a chip for every desk, each at least 44px
        const f = await rect(page, '.focus-chip');
        assert.ok(f.h >= 44, 'focus chip height ' + f.h);
        const names = await val(page, `JSON.stringify([...document.querySelectorAll('#focus-chips .focus-chip')].map((o) => o.textContent))`);
        assert.ok(JSON.parse(names).length >= 12, 'every desk has a chip: ' + names);
        const mainLabel = await val(page, `ROLES.main.label`);
        assert.ok(JSON.parse(names).includes(mainLabel), 'the main desk is on a chip under the label of its plate: ' + names);
        assert.match(names, /Lead QA/);
        assert.equal(await val(page, `document.getElementById('focus-chips').querySelector('[data-desk=main]').getAttribute('aria-label')`), mainLabel + ' (meja sendiri)');
        await val(page, `[...document.querySelectorAll('#focus-chips .focus-chip')].find((o) => o.textContent === 'Lead QA').click(); true`);
        await page.waitFor(`mainAgent().man`);
      } finally { await back(page); }
    },
  },
  {
    name: 'responsive: the chip and the bar are for small screens only; the wide page does not show them',
    async run(page) {
      for (const id of ['focus-chips', 'legend-toggle', 'btn-menu', 'sheet-toggle']) {
        assert.equal(await val(page, `document.getElementById('${id}').getClientRects().length`), 0, id + ' at 1440');
      }
      assert.equal(await val(page, `document.getElementById('task-pos').hidden`), true);
    },
  },
  {
    name: 'responsive: phone touch targets are at least 44px (buttons, tabs, inputs)',
    async run(page) {
      try {
        await phone(page);
        await page.waitFor(`layout.cols === 0`);
        // the busiest state: the dock open with a target, the sheet open with task cards
        await val(page, `dockInput.focus(); dock.chips = ['lead-qa']; renderChips(); setDockState('expanded'); OfficeTasks.enqueue(taskStore, { text: 'x', targets: ['lead-qa', 'lead-ui'], folder: 'f', runner: 'claude' }, Date.now()); tasksChanged(); selectTab(tabButtons[0], false); setSheet(true); true`);
        await page.sleep(500);
        const small = await val(page, `(() => {
          const out = [];
          for (const e of document.querySelectorAll('button, [role=tab], [role=radio], input, textarea, select, a[href], summary')) {
            if (e.closest('[hidden]') || e.closest('dialog:not([open])')) continue;
            const cs = getComputedStyle(e);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            if (e.closest('aside') && !document.getElementById('side-panel').classList.contains('is-open') && !e.closest('.tabs') && e.id !== 'sheet-toggle') continue;
            const r = e.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (Math.min(r.width, r.height) < 43.5) out.push((e.id || e.className || e.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
          }
          return out;
        })()`);
        assert.deepEqual(small, [], 'smaller than 44px: ' + small.join(', '));
      } finally { await back(page); }
    },
  },
];
