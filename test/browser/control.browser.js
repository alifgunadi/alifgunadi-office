'use strict';
// AlifGunadi: click the floor to walk, a desk to talk, his own desk to sit down; blocked clicks; keyboard; camera turns.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
// Client (window) coordinates of a world point, for sending real mouse events.
const client = (page, x, y, z = 0) => val(page, `(() => { const r = canvas.getBoundingClientRect(), s = pj(${x}, ${y}, ${z}); return [r.left + s[0] * sc, r.top + s[1] * sc]; })()`);
const clickWorld = async (page, x, y, z = 0) => { const [cx, cy] = await client(page, x, y, z); await page.click(cx, cy); };
const man = (page) => val(page, `(() => { const a = mainAgent(); return a.man ? JSON.stringify({ mode: a.man.mode, kind: a.man.target && a.man.target.kind, id: a.man.target && a.man.target.id, x: a.x, y: a.y, loc: a.loc }) : 'null'; })()`).then((s) => (s === 'null' ? null : JSON.parse(s)));
const reduced = (page) => page.viewport(1440, 900, { reducedMotion: true });

// a piece of floor that is free and also visible (not hidden behind a wall or a desk), as the pointer would find it
const FLOOR = `(() => { const nav = layoutNav(layout); for (let y = layout.H - 20; y > 40; y -= 12) for (let x = layout.W * 0.45; x < layout.W * 0.95; x += 24) { if (!navFree(nav, x, y)) continue; const s = pj(x, y, 0), h = hitTest(s[0] * sc, s[1] * sc); if (h && h.kind === 'floor') return [x, y]; } return null; })()`;

module.exports = [
  {
    name: 'control: every desk front and the lounge can be reached from AlifGunadi\'s seat at every width (the floor plan is the same, only smaller)',
    async run(page) {
      for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
        await page.viewport(w, h);
        await page.waitFor(`layout && layout.cols === 0`);
        const r = JSON.parse(await val(page, `JSON.stringify((() => {
          const nav = layoutNav(layout), me = layout.byId.get('main'), s = deskSeat(me), bad = [];
          for (const p of layout.places) {
            const f = deskFront(p);
            if (!navFree(nav, f[0], f[1])) bad.push(p.id + ': front is blocked');
            else if (!navFindPath(nav, s[0], s[1], f[0], f[1])) bad.push(p.id + ': no path');
          }
          const hub = layout.lounge.hub;
          if (!navFindPath(nav, s[0], s[1], hub.x, hub.y)) bad.push('lounge hub: no path');
          return { bad, desks: layout.places.length };
        })())`));
        assert.deepEqual(r.bad, [], `${w}px (${r.desks} desks)`);
      }
    },
  },
  {
    name: 'control: clicking free floor walks AlifGunadi there along a path, and he stops and stands',
    async run(page) {
      const [fx, fy] = await val(page, FLOOR);
      await page.click(...(await client(page, fx, fy)));
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'walking'`);
      assert.equal(await val(page, `mainAgent().s > 0.5`), true, 'away from the desk (the chair slides out)');
      const loc = (await man(page)).loc;
      assert.equal(loc, 'walking');
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'standing'`, 15000);
      const m = await man(page);
      assert.ok(Math.hypot(m.x - fx, m.y - fy) < 4, `arrived at ${m.x.toFixed(1)},${m.y.toFixed(1)} instead of ${fx},${fy}`);
      assert.equal(m.loc, 'on the floor');
    },
  },
  {
    name: 'control: the walk really takes time (about 140 units a second), and clicking elsewhere changes course from where he is',
    async run(page) {
      const [fx, fy] = await val(page, FLOOR);
      await page.click(...(await client(page, fx, fy)));
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'walking'`);
      const total = await val(page, `mainAgent().man.path.total`);
      await page.sleep(500);
      const d = await val(page, `mainAgent().man.d`);
      assert.ok(d > 20 && d < 140 * 0.9, `walked ${d.toFixed(0)} of ${total.toFixed(0)} units in half a second`);
      const mid = await man(page);
      // change course: back to the first desk front
      const g = await val(page, `deskFront(layout.byId.get('lead-ux'))`);
      await page.click(...(await client(page, g[0], g[1])));
      await page.waitFor(`mainAgent().man.target.kind === 'desk'`);
      const start = await val(page, `mainAgent().man.path.pts[0]`);
      assert.ok(Math.hypot(start[0] - mid.x, start[1] - mid.y) < 80, 'new path starts near where he was, not at his desk');
    },
  },
  {
    name: 'control: clicking a desk walks to its front and starts a conversation facing the owner',
    async run(page) {
      await reduced(page);
      const p = await val(page, `(() => { const q = layout.byId.get('lead-qa'); return deskFront(q); })()`);
      await clickWorld(page, p[0], p[1]);
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'conversing'`);
      const m = await man(page);
      assert.equal(m.id, 'lead-qa');
      assert.ok(Math.hypot(m.x - p[0], m.y - p[1]) < 2);
      assert.equal(m.loc, 'talking to Lead QA');
      assert.deepEqual(await val(page, `mainAgent().man.facing`), [0, -1], 'looks at the owner behind the desk');
      assert.match(await val(page, `document.getElementById('announce').textContent`), /menghampiri Lead QA/);
    },
  },
  {
    name: 'control: clicking his own desk (or pressing Enter on it) sends him back to sit down',
    async run(page) {
      await reduced(page);
      const f = await val(page, FLOOR);
      await clickWorld(page, f[0], f[1]);
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'standing'`);
      const s = await val(page, `(() => { const q = layout.byId.get('main'); return [q.x + CX * q.k, q.y + 100 * q.k]; })()`);
      await clickWorld(page, s[0], s[1]);
      await page.waitFor(`!mainAgent().man`);
      assert.equal(await val(page, `mainAgent().s`), 0, 'seated again');
      assert.match(await val(page, `document.getElementById('announce').textContent`), /kembali ke mejanya/);
    },
  },
  {
    name: 'control: clicking a wall is refused with a message, a red ring and the not-allowed cursor; AlifGunadi stays put',
    async run(page) {
      await reduced(page);
      // the top of the back wall of the product room: it stands over free corridor on screen, but it is a wall
      const w = await val(page, `(() => { const z = layout.zones.find((q) => q.key === 'product'); return [z.x + z.w * 0.2, z.y + 3, wallHeight(z, 'top') - 2]; })()`);
      const [cx, cy] = await client(page, w[0], w[1], w[2]);
      await page.move(cx, cy);
      await page.waitFor(`hover && hover.kind === 'blocked'`);
      await page.sleep(100);
      assert.equal(await val(page, `canvas.style.cursor`), 'not-allowed');
      await page.click(cx, cy);
      assert.equal(await val(page, `document.getElementById('toast').hidden`), false);
      assert.equal(await val(page, `document.getElementById('toast').textContent`), 'Area ini tidak bisa dilewati.');
      assert.equal(await val(page, `!!flash`), true, 'the red ring');
      assert.equal(await man(page), null, 'he did not move');
    },
  },
  {
    name: 'control: hovering a desk outlines it and shows pointer; hovering free floor shows a ring',
    async run(page) {
      const f = await val(page, `deskFront(layout.byId.get('lead-dba'))`);
      await page.move(...(await client(page, f[0], f[1])));
      await page.waitFor(`hover && hover.kind === 'desk' && hover.id === 'lead-dba'`);
      await page.sleep(100);
      assert.equal(await val(page, `canvas.style.cursor`), 'pointer');
      const own = await val(page, `(() => { const q = layout.byId.get('main'); return [q.x + CX * q.k, q.y + 110 * q.k]; })()`);
      await page.move(...(await client(page, own[0], own[1])));
      await page.waitFor(`hover && hover.kind === 'own'`);
      const free = await val(page, FLOOR);
      await page.move(...(await client(page, free[0], free[1])));
      await page.waitFor(`hover && hover.kind === 'floor'`);
      assert.equal(await val(page, `canvas.style.cursor`), 'pointer');
      await val(page, `canvas.dispatchEvent(new PointerEvent('pointerleave')); true`);
      await page.waitFor(`hover === null`);
    },
  },
  {
    name: 'control: Escape stops a walk where he is',
    async run(page) {
      const f = await val(page, FLOOR);
      await page.click(...(await client(page, f[0], f[1])));
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'walking'`);
      await page.sleep(300);
      await val(page, `document.body.focus()`);
      await page.key('Escape', { code: 'Escape' });
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'standing'`);
      const m = await man(page);
      assert.ok(Math.hypot(m.x - f[0], m.y - f[1]) > 10, 'stopped short of the target');
    },
  },
  {
    name: 'control: reduced motion puts him at the target at once, with no walk',
    async run(page) {
      await reduced(page);
      const f = await val(page, FLOOR);
      await clickWorld(page, f[0], f[1]);
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'standing'`, 2000);
      const m = await man(page);
      assert.ok(Math.hypot(m.x - f[0], m.y - f[1]) < 4, `at ${m.x.toFixed(1)},${m.y.toFixed(1)} instead of ${f}`);
    },
  },
  {
    name: 'control: the list of agents does the same by keyboard (Enter on a desk, Enter on AlifGunadi)',
    async run(page) {
      await reduced(page);
      await val(page, `[...document.querySelectorAll('#agent-list li')].find((l) => l.dataset.id === 'lead-ui').focus()`);
      await page.key('Enter');
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'conversing' && mainAgent().man.target.id === 'lead-ui'`);
      await val(page, `[...document.querySelectorAll('#agent-list li')].find((l) => l.dataset.id === 'main').focus()`);
      await page.key('Enter');
      await page.waitFor(`!mainAgent().man`);
    },
  },
  {
    name: 'control: turning the camera keeps him where he is in the world, and clicks hit the right desk at every turn',
    async run(page) {
      await reduced(page);
      const f = await val(page, FLOOR);
      await clickWorld(page, f[0], f[1]);
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'standing'`);
      for (const rot of [1, 2, 3, 0]) {
        await val(page, `setCamera({ rot: ${rot} }); true`);
        await page.waitFor(`layout.rot === ${rot}`);
        await page.sleep(200);
        const m = await man(page);
        assert.ok(m && Math.hypot(m.x - f[0], m.y - f[1]) < 4, `still at the same world point at turn ${rot}`);
        const wrong = JSON.parse(await val(page, `JSON.stringify(layout.places.filter((p) => {
          const front = deskFront(p), s = pj(front[0], front[1], 0), h = hitTest(s[0] * sc, s[1] * sc);
          const mon = pj(p.x + CX * p.k, p.y + 110 * p.k, 40), h2 = hitTest(mon[0] * sc, mon[1] * sc);
          return !(h && h.id === p.id) || !(h2 && h2.id === p.id);
        }).map((p) => p.id))`));
        assert.deepEqual(wrong, [], `desks whose front or monitor does not hit them at turn ${rot}`);
      }
    },
  },
  {
    name: 'control: narrowing the window keeps the walk (same floor plan), but a layout change (a guest desk adds the Guests strip) sends him back to his desk',
    async run(page) {
      await reduced(page);
      const f = await val(page, FLOOR);
      await clickWorld(page, f[0], f[1]);
      await page.waitFor(`mainAgent().man`);
      await page.viewport(600, 700, { reducedMotion: true });
      await page.waitFor(`layout.cols === 0 && availW < 700`);
      assert.ok(await val(page, `!!mainAgent().man`), 'still standing where he was');
      await val(page, `serverState.desks['guest-a'] = { id: 'guest-a', status: 'idle', updatedAt: Date.now() }; rebuildDesks(); true`);
      try {
        await page.waitFor(`!mainAgent().man`);
        assert.equal(await val(page, `mainAgent().s`), 0);
      } finally {
        await val(page, `delete serverState.desks['guest-a']; rebuildDesks(); true`);
      }
    },
  },
  {
    name: 'control: after ten quiet minutes he walks back to his desk by himself',
    async run(page) {
      await reduced(page);
      const f = await val(page, FLOOR);
      await clickWorld(page, f[0], f[1]);
      await page.waitFor(`mainAgent().man && mainAgent().man.mode === 'standing'`);
      await val(page, `mainAgent().man.last = performance.now() - LEAVE_GRACE_MS - 1000; true`);
      await page.waitFor(`!mainAgent().man`, 6000);
    },
  },
  {
    name: 'control: dragging the floor to pan at 130% is not a click',
    async run(page) {
      await page.key('+', { text: '+' });
      await page.waitFor(`stage.scrollWidth > stage.clientWidth + 1`);
      await val(page, `stage.scrollLeft = 100; true`);
      const free = await val(page, FLOOR);
      const [cx, cy] = await client(page, free[0], free[1]);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 60, y: cy, button: 'left', buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 60, y: cy, button: 'left', clickCount: 1 });
      await page.sleep(300);
      assert.equal(await man(page), null, 'a drag must not send him anywhere');
      assert.equal(await val(page, `document.getElementById('toast').hidden`), true);
    },
  },
];
