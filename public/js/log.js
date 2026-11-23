'use strict';

const logEl = document.getElementById('log');
const activityEmptyEl = document.getElementById('activity-empty');
const logKey = (e) => (e ? e.t + '|' + e.desk + '|' + e.text : '');
let lastLogKey = '';
function renderLog(entries) {
  // The server sends the whole log each time, but normally only a few entries are new (oldest first).
  // Add just those on top and trim the tail; rebuild only when the previous newest entry is not found.
  entries = entries.filter(Boolean);
  activityEmptyEl.hidden = entries.length > 0; // an empty log says so instead of leaving a blank panel
  const newest = logKey(entries[entries.length - 1]);
  if (newest === lastLogKey && logEl.childElementCount === entries.length) return;
  let from = 0;
  let incremental = false;
  if (lastLogKey) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (logKey(entries[i]) === lastLogKey) { from = i + 1; incremental = true; break; }
    }
  }
  if (!incremental) logEl.textContent = '';
  lastLogKey = newest;
  for (const e of entries.slice(from)) {
    const role = roleOf(e.desk);
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(e.t).toLocaleTimeString();
    const who = document.createElement('span');
    who.className = 'who';
    who.style.borderLeftColor = role.color;
    who.textContent = role.label || 'Unknown';
    const text = document.createElement('span');
    text.textContent = String(e.text ?? '');
    li.append(time, who, text);
    logEl.prepend(li);
  }
  while (logEl.childElementCount > entries.length) logEl.lastElementChild.remove();
}
