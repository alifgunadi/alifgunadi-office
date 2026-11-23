'use strict';
// Runs every test/browser/*.browser.js in one Edge session: node test/browser/run.js [name filter]
// Each file exports an array of { name, run(page) } cases; a case throws to fail.

const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./harness');

(async () => {
  const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.browser.js')).sort();
  const page = await launch();
  let failed = 0, passed = 0;
  try {
    for (const file of files) {
      for (const c of require(path.join(__dirname, file))) {
        if (filter && !filter.test(c.name)) continue;
        const before = page.problems.length;
        try {
          await page.viewport(1440, 900); // every case starts from the same window and the default camera
          await page.evaluate("document.querySelectorAll('dialog[open]').forEach((d) => d.close()); true"); // a case that failed halfway must not leave a modal dialog over the next ones
          await page.evaluate("try { localStorage.removeItem('alifgunadi-office.dock'); } catch (e) {} true");
          await page.evaluate("typeof resetCamera === 'function' && (resetCamera(), setMinimized(false), (() => { const a = mainAgent(); if (a) { a.man = null; a.s = 0; a.chair = 0; } toastEl.hidden = true; hover = null; flash = null; })(), true)");
          await page.evaluate("typeof taskStore !== 'undefined' && (taskStore.tasks.length = 0, taskStore.nextId = 1, dockInput.value = '', dock.chips = [], dock.answerTask = null, dock.error = '', dock.success = '', dock.sending = false, closeMention(), dockConfirm.hidden = true, document.getElementById('folder-list').hidden = true, document.getElementById('runner-list').hidden = true, setDockState('compact'), renderChips(), onConnectionChange(true), taskFilter = 'all', confirmingCancel = null, selectTab(tabButtons[1], false), tasksChanged(), true)");
          await c.run(page);
          const fresh = page.problems.slice(before);
          if (fresh.length) throw new Error('page problems: ' + fresh.join(' | '));
          passed++;
          console.log('PASS  ' + c.name);
        } catch (err) {
          failed++;
          console.log('FAIL  ' + c.name + '  -  ' + err.message);
        }
      }
    }
  } finally {
    await page.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
