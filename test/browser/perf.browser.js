'use strict';
// The cost of the render loop: idle draws stay at about 30 a second in every camera combination (4 turns x 3 zooms), a hidden page draws
// nothing, reduced motion draws on demand only, and one frame stays cheap. Bounds are loose on purpose (a busy machine must not fail them).

const assert = require('node:assert/strict');

const val = (page, expr) => page.evaluate(expr);

const instrument = (page) => val(page, `(() => {
  if (!window.__realRender) { window.__realRender = render; }
  window.__draws = 0; window.__ms = 0;
  render = (t) => { const a = performance.now(); try { return window.__realRender(t); } finally { window.__draws++; window.__ms += performance.now() - a; } };
  return true; })()`);
const restore = (page) => val(page, `(() => { if (window.__realRender) render = window.__realRender; return true; })()`);
const measure = async (page, ms) => {
  await val(page, `window.__draws = 0; window.__ms = 0; true`);
  await page.sleep(ms);
  return val(page, `({ draws: window.__draws, ms: window.__ms })`);
};

module.exports = [
  {
    name: 'performance: idle, every one of the 12 camera combinations draws about 30 frames a second and a frame is cheap',
    async run(page) {
      await instrument(page);
      try {
        const zooms = await val(page, `ZOOMS`);
        const rows = [];
        for (let rot = 0; rot < 4; rot++) {
          for (const zoom of zooms) {
            await val(page, `setCamera({ rot: ${rot}, zoom: ${zoom} }, { announceIt: false }); true`);
            await page.sleep(300); // the camera change itself draws; measure after it
            const m = await measure(page, 1000);
            rows.push({ rot, zoom, draws: m.draws, perFrame: m.draws ? m.ms / m.draws : 0 });
          }
        }
        for (const r of rows) {
          assert.ok(r.draws <= 40, 'idle draws a second at rot ' + r.rot + ' zoom ' + r.zoom + ': ' + r.draws);
          assert.ok(r.draws >= 5, 'the page still draws at rot ' + r.rot + ' zoom ' + r.zoom + ': ' + r.draws);
          assert.ok(r.perFrame < 25, 'ms a frame at rot ' + r.rot + ' zoom ' + r.zoom + ': ' + r.perFrame.toFixed(1));
        }
        const worst = rows.reduce((a, b) => (b.perFrame > a.perFrame ? b : a));
        console.log('      render cost: worst ' + worst.perFrame.toFixed(1) + ' ms a frame (rot ' + worst.rot + ', zoom ' + worst.zoom + '), draws a second ' + Math.min(...rows.map((r) => r.draws)) + '-' + Math.max(...rows.map((r) => r.draws)));
      } finally {
        await restore(page);
        await val(page, `setCamera({ rot: 0, zoom: 1 }, { announceIt: false }); true`);
      }
    },
  },
  {
    name: 'performance: a hidden page draws nothing at all, and draws again when it is shown',
    async run(page) {
      await instrument(page);
      try {
        await val(page, `Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); true`);
        await page.sleep(200);
        const hidden = await measure(page, 1500);
        assert.equal(hidden.draws, 0, 'draws while hidden');
        await val(page, `delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); true`);
        await page.sleep(300);
        const shown = await measure(page, 1000);
        assert.ok(shown.draws >= 5, 'draws again once shown: ' + shown.draws);
      } finally {
        await val(page, `delete document.hidden; true`);
        await restore(page);
      }
    },
  },
  {
    name: 'performance: with reduced motion the idle page draws on demand only (a handful a second), not in a loop',
    async run(page) {
      await page.viewport(1440, 900, { reducedMotion: true });
      await instrument(page);
      try {
        await page.sleep(500);
        const m = await measure(page, 2000);
        assert.ok(m.draws <= 8, 'draws in 2 s with reduced motion: ' + m.draws);
      } finally {
        await restore(page);
        await page.viewport(1440, 900, { reducedMotion: false });
      }
    },
  },
];
