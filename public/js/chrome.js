'use strict';

// ---------- page chrome around the canvas: zone legend, side-panel tabs, the AlifGunadi card ----------

// Zone legend: fixed chips in the corner of the stage (they replace the labels that used to float over the floor).
const LEGEND_ZONES = [['trainer', 'CEO Office'], ['product', 'Product'], ['eng', 'Engineering'], ['qa', 'QA'], ['lounge', 'Lounge & Pantry']];
(function buildLegend() {
  const list = document.getElementById('legend');
  for (const [key, label] of LEGEND_ZONES) {
    const li = document.createElement('li');
    li.className = 'zone-chip';
    li.style.setProperty('--zone', ZONES[key].wall);
    li.textContent = label;
    list.append(li);
  }
})();

// Tabs (WAI-ARIA tabs pattern: roving tabindex, arrows, Home/End). Both panels stay in the DOM: a hidden panel is
// still updated, so the activity log keeps filling while another tab is showing.
const tabButtons = [document.getElementById('tab-tasks'), document.getElementById('tab-activity'), document.getElementById('tab-context')];
const visibleTabs = () => tabButtons.filter((t) => !t.hidden); // the Konteks tab only exists in real mode

function selectTab(button, focus) {
  for (const tab of tabButtons) {
    const on = tab === button;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) button.focus();
}

for (const tab of tabButtons) {
  tab.addEventListener('click', () => selectTab(tab, false));
  tab.addEventListener('keydown', (e) => {
    const tabs = visibleTabs();
    const i = tabs.indexOf(tab);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i + tabs.length - 1) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) { e.preventDefault(); selectTab(next, true); }
  });
}

// Task filters: one pressed at a time. Nothing to filter yet (the task list arrives with the prompt dock).
for (const chip of document.querySelectorAll('.filters .chip')) {
  chip.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.filters .chip')) other.setAttribute('aria-pressed', String(other === chip));
  });
}

// AlifGunadi card: the status of the main desk, and the task load (zero until tasks exist).
const MAIN_STATE_TEXT = { working: 'Berjalan', waiting: 'Menunggu', done: 'Selesai', idle: 'Santai' };
const meStateEl = document.getElementById('me-state');
const meFillEl = document.getElementById('me-fill');
const meLoadEl = document.getElementById('me-load');
const tasksCountEl = document.getElementById('tasks-count');

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function updateChrome(list) {
  const main = list.find((d) => d.id === 'main');
  const status = (main && main.status) || 'idle';
  const label = MAIN_STATE_TEXT[status] || status;
  setText(meStateEl, main && main.activity ? label + ' · ' + main.activity : label);
  const { active, total } = OfficeTasks.load(taskStore);
  setText(meLoadEl, 'Tugas aktif ' + active + ' / ' + total);
  meFillEl.style.width = (total ? Math.round((active / total) * 100) : 0) + '%';
  const open = taskStore.tasks.filter((t) => !OfficeTasks.FINISHED.includes(t.status)).length;
  tasksCountEl.hidden = open === 0;
  setText(tasksCountEl, String(open));
}
