'use strict';
// The camera: turning, zoom, walls, shortcuts, saved choices, minimize, pan and the minimap.

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);
const readout = (page) => val(page, `document.getElementById('camera-readout').textContent`);
const click = (page, id) => val(page, `document.getElementById('${id}').click()`);

module.exports = [
  {
    name: 'camera: starts at 0° · 100% with the cutaway walls, and the card has the design controls',
    async run(page) {
      assert.equal(await readout(page), '0° · 100%');
      assert.equal(await val(page, `camera.walls`), 'cut');
      const r = JSON.parse(await val(page, `JSON.stringify({
        left: document.getElementById('cam-left').getBoundingClientRect().height, right: document.getElementById('cam-right').getBoundingClientRect().height,
        zoom: document.getElementById('cam-zoom-out').getBoundingClientRect().height, card: document.getElementById('camera').getBoundingClientRect().width,
        walls: [...document.querySelectorAll('#camera-walls [role=radio]')].map(b => b.textContent + ':' + b.getAttribute('aria-checked')),
        group: document.getElementById('camera').getAttribute('aria-label'), range: document.getElementById('cam-zoom').getAttribute('aria-valuetext') })`));
      assert.deepEqual([r.left, r.right, r.zoom, r.card], [44, 44, 40, 216]);
      assert.deepEqual(r.walls, ['Naik:false', 'Potong:true', 'Turun:false']);
      assert.equal(r.group, 'Kamera');
      assert.equal(r.range, '100%');
    },
  },
  {
    name: 'camera: the turn buttons rotate the floor a quarter turn, rebuild the layout and announce it',
    async run(page) {
      await click(page, 'cam-right');
      assert.equal(await readout(page), '90° · 100%');
      await page.waitFor(`layout.rot === 1`);
      assert.match(await val(page, `document.getElementById('announce').textContent`), /Kamera 90 derajat, zoom 100 persen/);
      assert.equal(await val(page, `document.getElementById('camera-compass').style.transform`), 'rotate(-90deg)');
      await click(page, 'cam-left'); await click(page, 'cam-left');
      assert.equal(await readout(page), '270° · 100%', 'wraps around');
      await click(page, 'cam-right');
      assert.equal(await readout(page), '0° · 100%');
    },
  },
  {
    name: 'camera: shortcuts Q/E turn, +/- zoom, 0 resets, and typing in a field is left alone',
    async run(page) {
      await val(page, `document.body.focus()`);
      await page.key('e', { text: 'e' });
      assert.equal(await readout(page), '90° · 100%');
      await page.key('q', { text: 'q' });
      assert.equal(await readout(page), '0° · 100%');
      await page.key('+', { text: '+' });
      assert.equal(await readout(page), '0° · 130%');
      await page.key('-', { text: '-' }); await page.key('-', { text: '-' });
      assert.equal(await readout(page), '0° · 80%');
      await page.key('e', { text: 'e' });
      await page.key('0', { text: '0' });
      assert.equal(await readout(page), '0° · 100%');
      // a text field must not trigger them
      await val(page, `(() => { const i = document.createElement('input'); i.id = 'tmp-input'; document.body.append(i); i.focus(); return true; })()`);
      await page.key('e', { text: 'e' });
      assert.equal(await readout(page), '0° · 100%', 'typing e in an input must not turn the camera');
      await val(page, `document.getElementById('tmp-input').remove()`);
    },
  },
  {
    name: 'camera: the wall modes are a radio group with arrow keys, and change the drawn walls',
    async run(page) {
      await val(page, `document.querySelector('#camera-walls [aria-checked=true]').focus()`);
      await page.key('ArrowRight');
      assert.equal(await val(page, `camera.walls`), 'down');
      await page.waitFor(`layout.walls === 'down'`);
      await page.key('ArrowLeft'); await page.key('ArrowLeft');
      assert.equal(await val(page, `camera.walls`), 'up');
      assert.equal(await val(page, `document.querySelector('#camera-walls [aria-checked=true]').dataset.walls`), 'up');
      assert.equal(await val(page, `document.querySelectorAll('#camera-walls [tabindex="0"]').length`), 1, 'roving tabindex');
    },
  },
  {
    name: 'camera: choices are saved per browser and restored after a reload',
    async run(page) {
      await click(page, 'cam-right');
      await page.key('+', { text: '+' });
      await click(page, 'camera-min');
      await page.evaluate('location.reload(); true');
      await page.sleep(1500);
      await page.waitFor(`document.getElementById('conn') && document.getElementById('conn').textContent === 'live'`, 15000);
      assert.equal(await readout(page), '90° · 130%');
      assert.equal(await val(page, `layout && layout.rot`), 1);
      assert.equal(await val(page, `document.getElementById('camera').classList.contains('is-min')`), true);
    },
  },
  {
    name: 'camera: bad saved values fall back to the defaults',
    async run(page) {
      await val(page, `localStorage.setItem('alifgunadi-office.camera', '{"rot":9,"zoom":2,"walls":"x"}'); true`);
      await page.evaluate('location.reload(); true');
      await page.sleep(1500);
      await page.waitFor(`document.getElementById('conn') && document.getElementById('conn').textContent === 'live'`, 15000);
      assert.equal(await readout(page), '0° · 100%');
      await val(page, `localStorage.removeItem('alifgunadi-office.camera'); true`);
    },
  },
  {
    name: 'camera: minimize turns the card into a chip, keeps the shortcuts and announces state to assistive tech',
    async run(page) {
      const b = () => val(page, `JSON.stringify({ exp: document.getElementById('camera-min').getAttribute('aria-expanded'), label: document.getElementById('camera-min').getAttribute('aria-label'), bodyHidden: document.getElementById('camera-body').hidden, w: Math.round(document.getElementById('camera').getBoundingClientRect().width) })`).then(JSON.parse);
      await click(page, 'camera-min');
      let s = await b();
      assert.deepEqual([s.exp, s.label, s.bodyHidden], ['false', 'Buka kamera', true]);
      assert.ok(s.w < 160, 'chip is narrow: ' + s.w);
      await val(page, `document.body.focus()`);
      await page.key('e', { text: 'e' });
      assert.equal(await readout(page), '90° · 100%', 'shortcuts still work when minimized');
      await click(page, 'camera-min');
      s = await b();
      assert.deepEqual([s.exp, s.label, s.bodyHidden], ['true', 'Minimalkan kamera', false]);
    },
  },
  {
    name: 'camera: on a phone the floor plan turns too (the buttons work and the turn is kept), and the wall mode can be cycled',
    async run(page) {
      await click(page, 'cam-right');
      await page.viewport(390, 844, { touch: true });
      await page.waitFor(`layout.cols === 0 && layout.rot === 1`);
      const r = JSON.parse(await val(page, `JSON.stringify({ dis: ['cam-left', 'cam-right'].map(i => document.getElementById(i).getAttribute('aria-disabled')), readout: document.getElementById('camera-readout').textContent, w: document.getElementById('cam-walls-cycle').textContent })`));
      assert.deepEqual(r.dis, ['false', 'false']);
      assert.equal(r.readout, '90° · 100%');
      assert.equal(r.w, 'Dinding: Potong');
      await val(page, `document.getElementById('cam-right').click(); true`);
      await page.waitFor(`layout.rot === 2`);
      await val(page, `document.getElementById('cam-walls-cycle').click(); true`);
      await page.waitFor(`camera.walls === 'down'`);
      assert.equal(await val(page, `document.getElementById('cam-walls-cycle').textContent`), 'Dinding: Turun');
      await page.viewport(1440, 900, { touch: false });
      await page.waitFor(`layout.cols === 0 && layout.rot === 2`);
      assert.equal(await readout(page), '180° · 100%');
    },
  },
  {
    name: 'camera: zoom 130% overflows the stage, shows the minimap, and the minimap pans',
    async run(page) {
      await page.key('+', { text: '+' });
      await page.waitFor(`stage.scrollWidth > stage.clientWidth + 1`);
      await page.waitFor(`!document.querySelector('.minimap-card').hidden`);
      const before = await val(page, `stage.scrollLeft`);
      const moved = await val(page, `(() => { const r = document.getElementById('minimap').getBoundingClientRect();
        document.getElementById('minimap').dispatchEvent(new PointerEvent('pointerdown', { clientX: r.right - 4, clientY: r.top + r.height / 2, pointerId: 1, bubbles: true }));
        return stage.scrollLeft; })()`);
      assert.ok(moved > before, `minimap click scrolled ${before} -> ${moved}`);
      await page.key('0', { text: '0' });
      await page.waitFor(`document.querySelector('.minimap-card').hidden`);
    },
  },
  {
    name: 'camera: zooming in from the fitted view stays centred, and a half turn at 130% mirrors the view instead of jumping to a corner',
    async run(page) {
      await page.key('+', { text: '+' });
      await page.waitFor(`stage.scrollWidth > stage.clientWidth + 1`);
      await page.sleep(300);
      const centre = () => val(page, `(stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth`);
      assert.ok(Math.abs((await centre()) - 0.5) < 0.05, 'centred after zooming in');
      await val(page, `stage.scrollLeft = stage.scrollWidth * 0.3; true`);
      const fx = await centre();
      await page.key('e', { text: 'e' }); await page.key('e', { text: 'e' }); // a half turn: the floor is the same size, seen from the other side
      await page.sleep(500);
      const after = await centre();
      assert.ok(Math.abs(after - fx) < 0.08, `centre ${fx.toFixed(3)} -> ${after.toFixed(3)}`);
    },
  },
  {
    name: 'camera: the canvas backing store never exceeds the pixel budget, even at 130% on a dense screen',
    async run(page) {
      await page.key('+', { text: '+' });
      await page.sleep(400);
      const px = await val(page, `canvas.width * canvas.height`);
      assert.ok(px <= 16.5e6, 'pixels ' + px);
    },
  },
  {
    name: 'camera: dragging the floor pans when zoomed, and a plain click does not move it',
    async run(page) {
      await page.key('+', { text: '+' });
      await page.waitFor(`stage.scrollWidth > stage.clientWidth + 1`);
      await val(page, `stage.scrollLeft = 100; true`);
      const x0 = await val(page, `stage.scrollLeft`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 560, y: 400, button: 'left', buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 560, y: 400, button: 'left', clickCount: 1 });
      const x1 = await val(page, `stage.scrollLeft`);
      assert.ok(x1 < x0, `dragged right so the view moved left: ${x0} -> ${x1}`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 502, y: 400, button: 'left', clickCount: 1 });
      assert.equal(await val(page, `stage.scrollLeft`), x1, 'a 2px wobble is a click, not a drag');
    },
  },
  {
    name: 'camera: every turn and zoom draws without page errors and keeps the canvas sized to the window',
    async run(page) {
      for (const rot of [0, 1, 2, 3]) {
        for (const zoom of [0.8, 1, 1.3]) {
          await val(page, `setCamera({ rot: ${rot}, zoom: ${zoom} }); true`);
          await page.sleep(150);
          const ok = await val(page, `layout.rot === ${rot} && canvas.width > 0 && parseFloat(canvas.style.width) > 0`);
          assert.equal(ok, true, `turn ${rot} zoom ${zoom}`);
        }
      }
    },
  },
];
