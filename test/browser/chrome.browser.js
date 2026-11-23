'use strict';
// The page chrome around the canvas: layout mode, top bar, legend, tabs, AlifGunadi card, touch sizes.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);

module.exports = [
  {
    name: 'the isometric floor plan is used at every width and fits the stage (the whole floor, scaled down on a phone)',
    async run(page) {
      assert.equal(await val(page, 'layout.cols'), 0, 'cols at 1440');
      const w = await val(page, 'Math.round(availW)');
      assert.ok(w > 1000 && w < 1100, 'stage width ' + w);
      for (const [vw, vh] of [[1280, 800], [1100, 800], [1024, 768], [800, 700], [600, 700], [390, 844]]) {
        await page.viewport(vw, vh);
        await page.waitFor(`layout.cols === 0 && parseFloat(canvas.style.width) > 0`);
        await page.sleep(200);
        const r = JSON.parse(await val(page, `JSON.stringify({ cols: layout.cols, cw: parseFloat(canvas.style.width), avail: availW, scrolls: stage.scrollWidth > stage.clientWidth + 1 })`));
        assert.equal(r.cols, 0, 'cols at ' + vw);
        assert.ok(r.cw <= r.avail + 1 && !r.scrolls, 'the floor fits the stage at ' + vw + ': ' + JSON.stringify(r));
      }
    },
  },
  {
    name: 'top bar: title, live pill and the gear; the gear menu lists Folder induk, Restart and Stop (Stop in the danger colours)',
    async run(page) {
      const r = JSON.parse(await val(page, `JSON.stringify({
        title: document.querySelector('.topbar h1').textContent, conn: document.getElementById('conn').textContent,
        buttons: [...document.querySelectorAll('.topbar button')].filter((b) => b.getClientRects().length).map((b) => b.id),
        hidden: document.getElementById('gear-pop').hidden, exp: document.getElementById('btn-settings').getAttribute('aria-expanded') })`));
      assert.equal(r.title, "ALIF'S OFFICE");
      assert.equal(r.conn, 'live');
      assert.deepEqual(r.buttons, ['btn-settings'], 'the bar shows only the gear at 1440');
      assert.deepEqual([r.hidden, r.exp], [true, 'false']);
      await val(page, `document.getElementById('btn-settings').click(); true`);
      const m = JSON.parse(await val(page, `JSON.stringify({
        exp: document.getElementById('btn-settings').getAttribute('aria-expanded'), role: document.getElementById('gear-pop').getAttribute('role'),
        items: [...document.querySelectorAll('#gear-pop [role=menuitem]')].map((b) => b.textContent), focus: document.activeElement.id,
        stopColor: getComputedStyle(document.getElementById('btn-stop')).color, stopBg: getComputedStyle(document.getElementById('btn-stop')).backgroundColor })`));
      assert.deepEqual([m.exp, m.role], ['true', 'menu']);
      assert.deepEqual(m.items, ['Folder induk', 'Restart', 'Stop']);
      assert.equal(m.focus, 'gear-folder');
      assert.equal(m.stopBg, 'rgb(253, 236, 236)', 'Stop has the danger background');
      // keys: arrows move (and wrap), Escape closes and gives the focus back to the gear
      await page.key('ArrowDown');
      assert.equal(await val(page, `document.activeElement.id`), 'btn-restart');
      await page.key('End');
      assert.equal(await val(page, `document.activeElement.id`), 'btn-stop');
      await page.key('ArrowDown');
      assert.equal(await val(page, `document.activeElement.id`), 'gear-folder');
      await page.key('Escape');
      assert.deepEqual(await val(page, `[document.getElementById('gear-pop').hidden, document.activeElement.id, document.getElementById('btn-settings').getAttribute('aria-expanded')]`), [true, 'btn-settings', 'false']);
      // a click outside closes it
      await val(page, `document.getElementById('btn-settings').click(); true`);
      await page.click(300, 400);
      assert.equal(await val(page, `document.getElementById('gear-pop').hidden`), true);
      // Restart and Stop do what the old buttons did: they ask the server (the call is intercepted here, nothing is stopped)
      await val(page, `window.__asked = []; window.__send = sendControl; sendControl = async (a) => { window.__asked.push(a); return false; }; document.getElementById('btn-settings').click(); document.getElementById('btn-restart').click(); document.getElementById('btn-settings').click(); document.getElementById('btn-stop').click(); true`);
      await page.waitFor(`window.__asked.length >= 2`);
      assert.deepEqual(await val(page, `window.__asked`), ['restart', 'stop']);
      await val(page, `sendControl = window.__send; true`);
    },
  },
  {
    name: 'zone legend has the five zones and lets pointer events through to the canvas',
    async run(page) {
      const labels = JSON.parse(await val(page, `JSON.stringify([...document.querySelectorAll('#legend li')].map(li => li.textContent))`));
      assert.deepEqual(labels, ['CEO Office', 'Product', 'Engineering', 'QA', 'Lounge & Pantry']);
      const hit = await val(page, `(() => { const r = document.querySelector('#legend li').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el.closest('#legend') === null; })()`);
      assert.equal(hit, true, 'legend must not capture the pointer');
    },
  },
  {
    name: 'tabs: Activity is selected first; arrows, Home and End move the selection with a roving tabindex',
    async run(page) {
      const state = () => val(page, `JSON.stringify({ sel: ['tab-tasks', 'tab-activity'].map(i => document.getElementById(i).getAttribute('aria-selected')), idx: ['tab-tasks', 'tab-activity'].map(i => document.getElementById(i).tabIndex), tasksHidden: document.getElementById('panel-tasks').hidden, actHidden: document.getElementById('panel-activity').hidden, focus: document.activeElement.id })`).then(JSON.parse);
      let s = await state();
      assert.deepEqual([s.sel, s.idx, s.tasksHidden, s.actHidden], [['false', 'true'], [-1, 0], true, false]);
      await val(page, `document.getElementById('tab-activity').focus()`);
      await page.key('ArrowLeft');
      s = await state();
      assert.deepEqual([s.sel, s.idx, s.tasksHidden, s.actHidden, s.focus], [['true', 'false'], [0, -1], false, true, 'tab-tasks']);
      await page.key('ArrowRight');
      s = await state();
      assert.deepEqual([s.sel, s.focus], [['false', 'true'], 'tab-activity']);
      await page.key('Home');
      assert.equal((await state()).focus, 'tab-tasks');
      await page.key('End');
      assert.equal((await state()).focus, 'tab-activity');
    },
  },
  {
    name: 'a hidden Activity panel keeps filling, and the Tasks count badge is hidden at zero',
    async run(page) {
      await val(page, `document.getElementById('tab-tasks').click()`);
      assert.equal(await val(page, `document.getElementById('panel-activity').hidden`), true);
      assert.equal(await val(page, `getComputedStyle(document.getElementById('tasks-count')).display`), 'none');
      const before = await val(page, `document.querySelectorAll('#log li').length`);
      await page.post({ hook_event_name: 'PreToolUse', session_id: 'b-log', tool_name: 'Read', tool_input: { file_path: 'chrome-test.js' } });
      await page.waitFor(`document.querySelectorAll('#log li').length > ${before} || (document.querySelector('#log li') || { textContent: '' }).textContent.includes('chrome-test.js')`);
      await val(page, `document.getElementById('tab-activity').click()`);
    },
  },
  {
    name: 'the AlifGunadi card follows the main desk',
    async run(page) {
      await page.post({ hook_event_name: 'UserPromptSubmit', session_id: 'b-card' });
      await page.waitFor(`document.getElementById('me-state').textContent.startsWith('Berjalan')`);
      assert.equal(await val(page, `document.getElementById('me-load').textContent`), 'Tugas aktif 0 / 0');
      await page.post({ hook_event_name: 'Stop', session_id: 'b-card' });
    },
  },
  {
    name: 'keyboard focus shows the 2px ring in the focus colour',
    async run(page) {
      const r = JSON.parse(await val(page, `(() => { const b = document.getElementById('btn-settings'); b.focus(); const c = getComputedStyle(b); return JSON.stringify({ w: c.outlineWidth, s: c.outlineStyle, c: c.outlineColor, f: document.activeElement === b, vis: b.matches(':focus-visible') }); })()`));
      assert.deepEqual([r.f, r.vis, r.s, r.c], [true, true, 'solid', 'rgb(37, 99, 235)']);
      // the browser rounds outline widths down to whole device pixels (2 CSS px is 1.6 at 125% scaling)
      assert.ok(parseFloat(r.w) >= 1.5, 'ring width ' + r.w);
    },
  },
  {
    name: 'touch screens get 44px controls whatever the width',
    async run(page) {
      await page.viewport(1440, 900, { touch: true });
      const coarse = await val(page, `matchMedia('(any-pointer: coarse)').matches`);
      assert.equal(coarse, true, 'touch emulation should make any-pointer coarse');
      const r = JSON.parse(await val(page, `JSON.stringify({ gear: document.getElementById('btn-settings').getBoundingClientRect().height, tab: document.getElementById('tab-activity').getBoundingClientRect().height })`));
      assert.deepEqual([r.gear, r.tab], [44, 44]);
      await val(page, `document.getElementById('btn-settings').click(); true`);
      const items = await val(page, `[...document.querySelectorAll('#gear-pop [role=menuitem]')].map((b) => b.getBoundingClientRect().height)`);
      assert.ok(items.length === 3 && items.every((h) => h >= 44), 'menu items ' + items);
      await val(page, `document.getElementById('btn-settings').click(); true`);
      await page.viewport(1440, 900, { touch: false });
    },
  },
  {
    name: 'the content security policy blocks an injected inline script and the page has no external requests',
    async run(page) {
      assert.equal(await val(page, `(() => { window.__x = 0; const s = document.createElement('script'); s.textContent = 'window.__x = 1'; document.head.appendChild(s); return window.__x; })()`), 0);
      await page.sleep(400);
      page.expectProblems(/Content Security Policy/i);
      const external = await val(page, `performance.getEntriesByType('resource').map(r => r.name).filter(n => !n.startsWith(location.origin))`);
      assert.deepEqual(external, []);
    },
  },
];
