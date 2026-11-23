'use strict';
// The wide floor plan: two rows of rooms, every desk in its room, the ways from the desks to the lounge are walkable, the camera turns keep it
// together, and the Guests strip exists only while there are guest desks. Asserts the arrangement and the behaviour, not pixel positions.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const json = async (page, expr) => JSON.parse(await val(page, `JSON.stringify(${expr})`));

// Routes of every desk (buildRoute) walk through free floor: each straight piece after the walkway in front of the desk is free on the grid
// of AlifGunadi's navigation (that grid has the walls with their doors and all furniture in it).
const ROUTES = `(() => {
  const nav = layoutNav(layout), bad = [];
  for (const p of layout.places) {
    const a = { id: p.id }; // a copy: the real agents keep their own routes
    const first = layout.lounge.slots.find((s) => s.type === 'coffee');
    buildRoute(a, first);
    const pts = a.route.slice(2); // from the walkway beside the desk on
    for (let i = 1; i < pts.length; i++) {
      if (!navLineFree(nav, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])) bad.push(p.id + ': blocked between ' + pts[i - 1].map(Math.round) + ' and ' + pts[i].map(Math.round));
    }
  }
  return bad;
})()`;

const GEOMETRY = `(() => {
  const L = layout, out = { zones: {}, bad: [], W: L.W, H: L.H };
  for (const z of L.zones) out.zones[z.key] = { x: z.x, y: z.y, w: z.w, h: z.h, row: z.row };
  let area = 0;
  for (const z of L.zones) area += z.w * z.h;
  out.coverage = area / (L.W * L.H);
  for (const p of L.places) {
    const z = p.zone, k = p.k;
    const x0 = p.x + (CX - 75) * k, x1 = p.x + (CX + 75) * k, y0 = p.y + 56 * k, y1 = p.y + 124 * k; // the desk and the chair behind it
    if (x0 < z.x + T_WALL || x1 > z.x + z.w - T_WALL || y0 < z.y + T_WALL || y1 > z.y + z.h - LBL) out.bad.push(p.id + ' is not inside its room');
  }
  return out;
})()`;

module.exports = [
  {
    name: 'floor plan: the rooms tile the floor in two rows, with the roles in the rooms of their divisions',
    async run(page) {
      await page.waitFor(`typeof layout !== 'undefined' && layout && layout.cols === 0`);
      const g = await json(page, GEOMETRY);
      const z = g.zones;
      assert.deepEqual(Object.keys(z).sort(), ['eng', 'lounge', 'product', 'qa', 'trainer']);
      assert.ok(Math.abs(g.coverage - 1) < 1e-9, 'the rooms cover the floor exactly, no corridor: ' + g.coverage);
      // back row: AlifGunadi's office, Product, Engineering side by side; front row: Quality & Security, the lounge
      assert.ok(z.trainer.y === 0 && z.product.y === 0 && z.eng.y === 0, 'the back row starts at the back');
      assert.ok(z.trainer.x < z.product.x && z.product.x < z.eng.x, 'back row order');
      assert.equal(z.trainer.x + z.trainer.w, z.product.x);
      assert.equal(z.product.x + z.product.w, z.eng.x);
      assert.ok(z.qa.y === z.trainer.y + z.trainer.h && z.lounge.y === z.qa.y, 'the front row starts where the back row ends');
      assert.ok(z.qa.x === 0 && z.qa.x + z.qa.w === z.lounge.x, 'front row order');
      assert.ok(z.lounge.w > z.qa.w && z.lounge.w > z.product.w, 'the lounge is the big room');
      assert.ok(Math.abs(g.W / g.H - 1.5) < 1e-9, 'the floor is 3:2');
      assert.deepEqual(g.bad, []);
      const zoneOf = await json(page, `Object.fromEntries(layout.places.map((p) => [p.id, p.zone.key]))`);
      assert.equal(zoneOf['main'], 'trainer');
      assert.equal(zoneOf['lead-qa'], 'qa');
      assert.equal(zoneOf['lead-dba'], 'eng');
      assert.equal(zoneOf['lead-ux'], 'product');
      // product: three desks on the back line, two on the front line; engineering: two and two
      const ys = await json(page, `(() => { const by = (key) => layout.places.filter((p) => p.zone.key === key).map((p) => Math.round(p.y)); return { product: by('product'), eng: by('eng') }; })()`);
      assert.equal(new Set(ys.product).size, 2);
      assert.equal(ys.product.filter((y) => y === Math.min(...ys.product)).length, 3);
      assert.equal(new Set(ys.eng).size, 2);
    },
  },
  {
    name: 'floor plan: every desk has a walkable way to the lounge, and every lounge slot can be reached from the hub',
    async run(page) {
      await page.waitFor(`typeof layout !== 'undefined' && layout && layout.cols === 0`);
      assert.deepEqual(await json(page, ROUTES), []);
      const bad = await json(page, `(() => {
        const nav = layoutNav(layout), L = layout.lounge, out = [];
        L.slots.forEach((s, i) => {
          if (s.type === 'sofa' || s.type === 'table') return; // these are on a cushion or a seat, which the grid treats as furniture
          const t = s.via || [s.x, s.y];
          if (!navFree(nav, s.x, s.y)) out.push('slot ' + i + ' (' + s.type + ') is not on free floor');
          if (!navLineFree(nav, L.hub.x, L.hub.y, t[0], t[1])) out.push('slot ' + i + ' (' + s.type + ') cannot be reached from the hub');
        });
        if (!navFree(nav, L.hub.x, L.hub.y)) out.push('the hub is blocked');
        return out;
      })()`);
      assert.deepEqual(bad, []);
    },
  },
  {
    name: 'floor plan: at every camera turn the layout is rebuilt for it and the walls between rooms keep their doors',
    async run(page) {
      for (const rot of [0, 1, 2, 3]) {
        await val(page, `setCamera({ rot: ${rot}, zoom: 1 }, { announceIt: false }); true`);
        await page.waitFor(`layout.rot === ${rot} && layout.cols === 0`);
        const r = await json(page, `(() => {
          const walls = layout.items.filter((it) => it.wall);
          const nav = layoutNav(layout);
          // a point in the middle of each door must be free on the grid, so the doors are really open
          const shut = [];
          for (const z of layout.zones) for (const d of z.doors) if (!navFree(nav, d.x, d.y)) shut.push(z.key + ' ' + d.side);
          return { walls: walls.length, shut, h: Math.max(...walls.map((w) => w.h)), W: layout.W, H: layout.H };
        })()`);
        assert.deepEqual(r.shut, [], 'closed doors at turn ' + rot);
        assert.ok(r.walls > 8, 'walls at turn ' + rot);
        assert.equal(r.W, 1500);
        assert.equal(r.H, 1000);
        assert.deepEqual(await json(page, ROUTES), [], 'routes at turn ' + rot);
      }
    },
  },
  {
    name: 'floor plan: a Guests strip appears along the front only while there are guest desks, and their way to the lounge is open',
    async run(page) {
      await page.waitFor(`typeof layout !== 'undefined' && layout && layout.cols === 0`);
      assert.equal(await val(page, `layout.zones.some((z) => z.key === 'guest')`), false, 'no strip without guests');
      const H0 = await val(page, `layout.H`);
      await val(page, `(() => { for (const id of ['guest-a', 'guest-b', 'guest-c', 'guest-d', 'guest-e', 'guest-f', 'guest-g']) serverState.desks[id] = { id, status: 'idle', updatedAt: Date.now() }; rebuildDesks(); return true; })()`);
      try {
        await page.waitFor(`layout && layout.zones.some((z) => z.key === 'guest') && layout.byId.has('guest-g')`);
        const r = await json(page, `(() => {
          const z = layout.zones.find((q) => q.key === 'guest'), lounge = layout.zones.find((q) => q.key === 'lounge');
          return { y: z.y, h: z.h, W: layout.W, H: layout.H, zw: z.w, lounge: lounge.y + lounge.h, doors: lounge.doors.length, desks: layout.places.filter((p) => p.zone === z).length };
        })()`);
        assert.equal(r.desks, 7);
        assert.equal(r.y, H0, 'the strip starts where the floor ended');
        assert.equal(r.H, r.y + r.h);
        assert.equal(r.y, r.lounge);
        assert.equal(r.doors, 1, 'the lounge has a door towards the guests');
        const g = await json(page, GEOMETRY);
        assert.deepEqual(g.bad, []);
        assert.ok(Math.abs(g.coverage - 1) < 1e-9);
        assert.deepEqual(await json(page, ROUTES), []);
      } finally {
        await val(page, `(() => { for (const id of Object.keys(serverState.desks)) if (id.startsWith('guest-')) delete serverState.desks[id]; rebuildDesks(); return true; })()`);
      }
      await page.waitFor(`layout && !layout.zones.some((z) => z.key === 'guest')`);
    },
  },
];
