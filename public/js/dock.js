'use strict';

// ---------- the prompt dock: write a task, address it with @mentions, pick a folder and a runner, send ----------
// "Mode simulasi": sending creates tasks in the page's own task model (tasklist.js); no agent is started anywhere.

const dockEl = document.getElementById('dock');
const dockInput = document.getElementById('dock-input');
const dockChips = document.getElementById('dock-chips');
const dockWho = document.getElementById('dock-who');
const dockHint = document.getElementById('dock-hint');
const dockSend = document.getElementById('dock-send');
const dockConfirm = document.getElementById('dock-confirm');
const mentionList = document.getElementById('mention-list');
const folderBtn = document.getElementById('dock-folder');
const runnerBtn = document.getElementById('dock-runner');

const FOLDERS = ['alifgunadi-office', 'design-system', 'api-gateway']; // sample data for the simulation
const RUNNERS = [
  { id: 'claude', ok: true }, { id: 'opencode', ok: true },
  { id: 'antigravity', ok: false, why: 'CLI tidak ditemukan di PATH' },
];
// In real mode the lists come from the server (ids only: the page never knows a path or a command).
const folderList = () => (realMode() ? session.workspaces.map((w) => w.id) : FOLDERS);
const runnerList = () => (realMode() ? session.runners : RUNNERS);
const REAL_ERRORS = {
  bad_text: 'Teks kosong atau terlalu panjang (maksimum 4000 karakter, termasuk @mention).',
  runner_unavailable: 'Runner ini tidak tersedia di server.',
  workspace_unavailable: 'Folder ini tidak tersedia di server.',
  too_many_prompts: 'Terlalu banyak tugas dikirim dalam semenit. Coba lagi sebentar lagi.',
  too_many_targets: 'Terlalu banyak target dalam satu tugas.',
  runner_disabled: 'Runner dinonaktifkan di server.',
};
const PLACEHOLDER = 'Ketik tugas atau @mention agent / divisi…';
const SENDING_MS = 600, SUCCESS_MS = 4000;

const dock = { chips: [], folder: FOLDERS[0], runner: 'claude', sending: false, live: false, answerTask: null, error: '', success: '', successTimer: 0, mention: null, active: -1 };

const nameOf = (id) => roleOf(id).label;
const guestIds = () => desks.filter((d) => !hasOwn(ROLES, d.id)).map((d) => d.id);

// ---- state of the dock: compact (one line) or expanded (targets, folder, runner, hints)

function setDockState(state) {
  dockEl.dataset.state = state;
}

function expandDock() {
  setDockState('expanded');
}

// The dock shrinks back to one line when focus leaves it and there is nothing in it.
function maybeCollapse() {
  if (dock.sending || dockEl.contains(document.activeElement)) return;
  if (!dockInput.value.trim() && !dock.chips.length && dockConfirm.hidden) setDockState('compact');
}

// ---- targets

function renderChips() {
  dockChips.textContent = '';
  for (const id of dock.chips) {
    const li = document.createElement('li');
    li.className = 'target-chip';
    li.textContent = '@' + id;
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Hapus target @' + id);
    x.textContent = '×';
    x.addEventListener('click', () => { dock.chips = dock.chips.filter((c) => c !== id); if (dock.answerTask) dock.answerTask = null; renderChips(); dockInput.focus(); });
    li.append(x);
    dockChips.append(li);
  }
  // the line above the input: who this conversation is with
  if (dock.answerTask) {
    const t = taskStore.tasks.find((q) => q.id === dock.answerTask);
    dockWho.textContent = 'Membalas ' + (t ? nameOf(t.deskId) : 'agent') + ' (@' + (t ? t.deskId : '') + ')';
    dockWho.hidden = false;
    dockInput.placeholder = 'Balas ke ' + (t ? nameOf(t.deskId) : 'agent') + '…';
  } else if (dock.chips.length === 1) {
    dockWho.textContent = 'Berbicara dengan ' + nameOf(dock.chips[0]) + ' (@' + dock.chips[0] + ')';
    dockWho.hidden = false;
    dockInput.placeholder = 'Tulis arahan untuk ' + nameOf(dock.chips[0]) + '…';
  } else {
    dockWho.hidden = true;
    dockInput.placeholder = PLACEHOLDER;
  }
  refreshHint();
}

function addChip(id) {
  if (!dock.chips.includes(id)) dock.chips.push(id);
  renderChips();
}

// All the agents this prompt goes to: the chips plus whatever the text mentions.
function currentTargets() {
  const r = OfficeMentions.resolve(dockInput.value, guestIds());
  return { ids: [...new Set([...dock.chips, ...r.targets])], resolved: r };
}

// A prompt with no @mention and no chosen target is Alif Gunadi's own: he (the main desk) is the default one who does the work.
// The server applies the same rule to a text without a known @mention, so nothing is added to the text for him.
const DEFAULT_DESK = OfficeRoles.MAIN_DESK;
function effectiveTargets() {
  const { ids, resolved } = currentTargets();
  if (ids.length || !dockInput.value.trim()) return { ids, resolved, byDefault: false };
  return { ids: [DEFAULT_DESK], resolved, byDefault: true };
}

// ---- the line under the input: an error, the connection, a success, or what will happen

function refreshHint() {
  let text = '', kind = '';
  if (dock.error) { text = dock.error; kind = 'error'; }
  else if (!dock.live) { text = 'Menunggu koneksi server…'; kind = 'error'; }
  else if (realMode() && !dock.folder) { text = 'Belum ada folder kerja. Pilih folder induk di Pengaturan (ikon gerigi) atau atur ALIFGUNADI_OFFICE_WORKSPACES di server.'; kind = 'error'; }
  else if (dock.success) { text = dock.success; kind = 'ok'; }
  else {
    const { ids, resolved, byDefault } = effectiveTargets();
    text = byDefault ? 'Tanpa @mention: dikerjakan oleh ' + nameOf(DEFAULT_DESK) + ' (default)' : OfficeMentions.describe(ids, resolved, nameOf);
    if (resolved.unknown.length) text += (text ? ' · ' : '') + '@' + resolved.unknown.join(', @') + ' tidak dikenal (dikirim sebagai teks biasa)';
    kind = 'preview';
  }
  dockHint.textContent = text;
  dockHint.dataset.kind = kind;
  dockInput.setAttribute('aria-invalid', String(Boolean(dock.error)));
}

function setError(text) {
  dock.error = text;
  dock.success = '';
  expandDock();
  refreshHint();
}

function setSuccess(text) {
  clearTimeout(dock.successTimer);
  dock.success = text;
  refreshHint();
  dock.successTimer = setTimeout(() => { dock.success = ''; refreshHint(); }, SUCCESS_MS);
}

function syncControls() {
  const locked = dock.sending || !dock.live;
  dockSend.disabled = locked || (realMode() && (!dock.folder || !dock.runner));
  dockSend.textContent = dock.sending ? 'Mengirim…' : 'Kirim';
  folderBtn.disabled = locked;
  runnerBtn.disabled = locked;
  dockInput.readOnly = dock.sending;
}

// net.js tells the dock whether the server is reachable. While it is not, nothing is sent and the draft stays where it is.
function onConnectionChange(live) {
  dock.live = live;
  syncControls();
  refreshHint();
}

// ---- the @mention popover (a combobox with a listbox, as the ARIA authoring practices describe)

function closeMention() {
  dock.mention = null;
  dock.active = -1;
  mentionList.hidden = true;
  mentionList.textContent = '';
  dockInput.setAttribute('aria-expanded', 'false');
  dockInput.removeAttribute('aria-activedescendant');
}

function setActiveMention(i) {
  const options = [...mentionList.querySelectorAll('[role="option"]')];
  if (!options.length) return;
  dock.active = (i + options.length) % options.length;
  options.forEach((o, k) => { o.classList.toggle('is-active', k === dock.active); o.setAttribute('aria-selected', String(k === dock.active)); });
  dockInput.setAttribute('aria-activedescendant', options[dock.active].id);
  options[dock.active].scrollIntoView({ block: 'nearest' });
}

function openMention() {
  const m = OfficeMentions.activeMention(dockInput.value, dockInput.selectionStart);
  if (!m) return closeMention();
  const items = OfficeMentions.suggestions(m.query, guestIds(), nameOf);
  if (!items.length) return closeMention();
  dock.mention = m;
  mentionList.textContent = '';
  let group = '', n = 0;
  for (const it of items) {
    if (it.group !== group) {
      group = it.group;
      const h = document.createElement('li');
      h.className = 'group';
      h.setAttribute('role', 'presentation');
      h.textContent = group;
      mentionList.append(h);
    }
    const li = document.createElement('li');
    li.id = 'mention-opt-' + n++;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.token = it.token;
    const label = document.createElement('span');
    label.textContent = it.label;
    const hint = document.createElement('small');
    hint.textContent = it.hint;
    li.append(label, hint);
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(it.token); }); // keep focus in the input
    mentionList.append(li);
  }
  mentionList.hidden = false;
  dockInput.setAttribute('aria-expanded', 'true');
  setActiveMention(0);
}

function pickMention(token) {
  const r = OfficeMentions.insertMention(dockInput.value, dockInput.selectionStart, token);
  dockInput.value = r.text;
  dockInput.setSelectionRange(r.caret, r.caret);
  closeMention();
  afterInput();
  dockInput.focus();
}

function autosize() {
  dockInput.style.height = 'auto';
  dockInput.style.height = Math.min(120, dockInput.scrollHeight) + 'px';
}

function afterInput() {
  autosize();
  dock.error = '';
  dock.success = '';
  refreshHint();
}

dockInput.addEventListener('input', () => { expandDock(); afterInput(); openMention(); saveDockDraftSoon(); if (typeof scheduleContext === 'function') scheduleContext(); });
dockInput.addEventListener('focus', expandDock);
dockInput.addEventListener('click', openMention);
dockInput.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) openMention(); });
dockInput.addEventListener('blur', () => setTimeout(() => { closeMention(); maybeCollapse(); }, 120));

dockInput.addEventListener('keydown', (e) => {
  const open = !mentionList.hidden;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setActiveMention(dock.active + (e.key === 'ArrowDown' ? 1 : -1)); return; }
  if (open && (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
    const o = mentionList.querySelectorAll('[role="option"]')[dock.active];
    if (o) { e.preventDefault(); pickMention(o.dataset.token); return; }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (open) { closeMention(); return; }
    if (!dockConfirm.hidden) { hideConfirm(); return; }
    dockInput.blur();
    stage.focus();
    return;
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); trySend(); }
});

// ---- sending

function showConfirm(n) {
  document.getElementById('dock-confirm-text').textContent = 'Kirim tugas ini ke semua ' + n + ' agent?';
  dockConfirm.hidden = false;
  document.getElementById('confirm-send').focus();
}

function hideConfirm() {
  dockConfirm.hidden = true;
  dockInput.focus();
}

// In real mode a send is a round trip to the server. The server decides the targets from the text, so a target chosen as a chip but
// not typed is added to the text as an @mention.
async function sendReal(text, ids, resolved) {
  // The main desk is never written into the text as an @mention: the server does not read @main, it defaults to him by itself.
  const missing = ids.filter((id) => id !== DEFAULT_DESK && !resolved.targets.includes(id));
  const body = { text: (missing.length ? missing.map((id) => '@' + id).join(' ') + ' ' : '') + text, workspaceId: dock.folder, runner: dock.runner };
  const urls = typeof contextUrlsToSend === 'function' ? contextUrlsToSend() : [];
  if (urls.length) body.urls = urls;
  const r = await api('POST', '/prompts', body);
  dock.sending = false;
  if (r.status === 202 && r.data) {
    const rejected = r.data.rejected || [];
    if (rejected.length) setError('Antrean ' + rejected.map((x) => nameOf(x.deskId)).join(', ') + ' penuh (maksimum ' + OfficeTasks.MAX_DESK_QUEUE + ').');
    if (r.data.tasks.length) {
      setSuccess('Task dikirim ke ' + dock.folder + ' dengan ' + dock.runner);
      announce(r.data.tasks.length === 1 ? 'Tugas dikirim' : 'Tugas dikirim ke ' + r.data.tasks.length + ' agent');
    }
  } else if (r.status === 401) {
    leaveRealMode();
    setError('Sesi berakhir. Buka kantor lagi lewat start-office.ps1 atau aplikasi desktop.');
  } else if (r.status === 0) {
    setError('Server tidak terjangkau. Tugas belum dikirim.');
  } else {
    setError(REAL_ERRORS[r.data && r.data.error] || 'Tugas ditolak server (HTTP ' + r.status + ').');
  }
  if (!dock.error) { dockInput.value = ''; dock.chips = []; renderChips(); autosize(); saveDockPrefs(); if (typeof contextAfterSend === 'function') contextAfterSend(); }
  syncControls();
}

function trySend(confirmed) {
  if (dock.sending || !dock.live) return;
  const text = dockInput.value.trim();
  if (!text) return setError('Tulis instruksi terlebih dahulu sebelum mengirim.');
  const { ids, resolved } = effectiveTargets(); // no target at all means Alif Gunadi, so there is no "pick a target" error any more
  if (resolved.everyone && !confirmed) return showConfirm(ids.length);
  dockConfirm.hidden = true;
  dock.sending = true;
  syncControls();
  if (realMode()) { sendReal(text, ids, resolved); return; }
  setTimeout(() => finishSend(text, ids), SENDING_MS); // a short pause stands in for the round trip to a runner
}

function finishSend(text, ids) {
  const now = Date.now();
  dock.sending = false;
  if (dock.answerTask) {
    const t = taskStore.tasks.find((q) => q.id === dock.answerTask);
    OfficeTasks.answer(taskStore, dock.answerTask, now);
    dock.answerTask = null;
    setSuccess('Balasan terkirim ke ' + (t ? nameOf(t.deskId) : 'agent') + ' (simulasi)');
    announce('Balasan terkirim');
  } else {
    const r = OfficeTasks.enqueue(taskStore, { text, targets: ids, folder: dock.folder, runner: dock.runner }, now);
    if (r.rejected.length) setError('Antrean ' + r.rejected.map((x) => nameOf(x.deskId)).join(', ') + ' penuh (maksimum ' + OfficeTasks.MAX_DESK_QUEUE + ').');
    if (r.tasks.length) {
      setSuccess('Task dijalankan di ' + dock.folder + ' dengan ' + dock.runner + ' (simulasi)');
      announce(r.tasks.length === 1 ? 'Tugas dikirim ke ' + nameOf(r.tasks[0].deskId) : 'Tugas dikirim ke ' + r.tasks.length + ' agent');
    }
    if (!r.tasks.length && !r.rejected.length) setError('Tidak ada target yang bisa menerima tugas.');
  }
  if (!dock.error) { dockInput.value = ''; dock.chips = []; renderChips(); autosize(); saveDockPrefs(); }
  syncControls();
  tasksChanged();
}

dockSend.addEventListener('click', () => trySend());
document.getElementById('confirm-send').addEventListener('click', () => trySend(true));
document.getElementById('confirm-cancel').addEventListener('click', hideConfirm);

// ---- Folder and Runner menus (a button that opens a listbox)

function makeMenu(btn, list, build, onPick) {
  let active = -1;
  const options = () => [...list.querySelectorAll('[role="option"]')];
  const mark = (i) => {
    const o = options();
    if (!o.length) return;
    active = (i + o.length) % o.length;
    o.forEach((el, k) => el.classList.toggle('is-active', k === active));
    list.setAttribute('aria-activedescendant', o[active].id);
  };
  function hide(returnFocus) {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }
  const pick = (token) => { onPick(token); hide(true); };
  function show() {
    for (const other of document.querySelectorAll('.popover--menu')) if (other !== list) other.hidden = true;
    list.textContent = '';
    build(list, pick);
    list.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const sel = options().findIndex((o) => o.getAttribute('aria-selected') === 'true');
    mark(sel >= 0 ? sel : 0);
    list.focus();
  }
  btn.addEventListener('click', () => (list.hidden ? show() : hide(true)));
  list.addEventListener('keydown', (e) => {
    const o = options();
    if (e.key === 'ArrowDown') { e.preventDefault(); mark(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); mark(0); }
    else if (e.key === 'End') { e.preventDefault(); mark(o.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (o[active] && o[active].getAttribute('aria-disabled') !== 'true') o[active].click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(true); }
    else if (e.key === 'Tab') hide(false);
  });
  document.addEventListener('mousedown', (e) => { if (!list.hidden && !list.contains(e.target) && !btn.contains(e.target)) hide(false); });
  // the data behind an open list changed: draw it again and keep the highlighted row
  return () => { if (list.hidden) return; const keep = active; list.textContent = ''; build(list, pick); mark(keep); };
}

function menuOption(list, id, label, { selected, disabled, why, onClick }) {
  const li = document.createElement('li');
  li.id = id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(Boolean(selected)));
  if (disabled) li.setAttribute('aria-disabled', 'true');
  const s = document.createElement('span');
  s.textContent = label;
  li.append(s);
  if (why) { const w = document.createElement('small'); w.textContent = why; li.append(w); li.setAttribute('aria-description', why); }
  li.addEventListener('click', () => { if (!disabled) onClick(); });
  list.append(li);
  return li;
}

const rebuildFolderMenu = makeMenu(folderBtn, document.getElementById('folder-list'), (list, pick) => {
  folderList().forEach((f, i) => menuOption(list, 'folder-opt-' + i, f, { selected: f === dock.folder, onClick: () => pick(f) }));
  const rule = document.createElement('li');
  rule.className = 'rule';
  rule.setAttribute('role', 'presentation');
  list.append(rule);
  menuOption(list, 'folder-opt-settings', 'Ubah folder induk…', {
    onClick: () => { list.hidden = true; folderBtn.setAttribute('aria-expanded', 'false'); openSettings(folderBtn); },
  });
}, (f) => { dock.folder = f; document.getElementById('dock-folder-name').textContent = f; saveDockPrefs(); });

makeMenu(runnerBtn, document.getElementById('runner-list'), (list, pick) => {
  runnerList().forEach((r, i) => menuOption(list, 'runner-opt-' + i, r.id, { selected: r.id === dock.runner, disabled: !r.ok, why: r.ok ? '' : 'tidak tersedia · ' + r.why, onClick: () => pick(r.id) }));
}, (r) => { dock.runner = r; document.getElementById('dock-runner-name').textContent = r; saveDockPrefs(); });

// Opening the list asks the server again, so a project folder made a minute ago is there without a restart.
folderBtn.addEventListener('click', async () => {
  if (!realMode()) return;
  const r = await api('GET', '/workspaces');
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.workspaces)) return;
  if (JSON.stringify(r.data.workspaces) === JSON.stringify(session.workspaces)) return;
  session.workspaces = r.data.workspaces;
  rebuildFolderMenu();
});

// The list of folders changed (a new parent folder was chosen): keep the choice if it is still there, else take the first one.
function foldersChanged() {
  if (realMode() && !folderList().includes(dock.folder)) dock.folder = folderList()[0] || '';
  document.getElementById('dock-folder-name').textContent = dock.folder || '—';
  refreshHint();
}

// ---- what survives a reload: the folder, the runner and the text being typed (kept in this browser only, never sent anywhere)
const DOCK_KEY = 'alifgunadi-office.dock';
function loadDockPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(DOCK_KEY));
    if (!v || typeof v !== 'object') return {};
    return { folder: typeof v.folder === 'string' ? v.folder.slice(0, 80) : '', runner: typeof v.runner === 'string' ? v.runner.slice(0, 40) : '', draft: typeof v.draft === 'string' ? v.draft.slice(0, 4000) : '' };
  } catch { return {}; }
}
const dockPrefs = loadDockPrefs();
let dockDraftTimer = 0;
function saveDockPrefs() {
  clearTimeout(dockDraftTimer);
  try { localStorage.setItem(DOCK_KEY, JSON.stringify({ folder: dock.folder, runner: dock.runner, draft: dockInput.value.slice(0, 4000) })); } catch { /* storage blocked */ }
}
function saveDockDraftSoon() {
  clearTimeout(dockDraftTimer);
  dockDraftTimer = setTimeout(saveDockPrefs, 400);
}
if (dockPrefs.draft) { dockInput.value = dockPrefs.draft; autosize(); }
// until the server says otherwise the page is a simulation, whose folders and runners are fixed lists
if (FOLDERS.includes(dockPrefs.folder)) dock.folder = dockPrefs.folder;
if (['claude', 'opencode'].includes(dockPrefs.runner)) dock.runner = dockPrefs.runner;
document.getElementById('dock-folder-name').textContent = dock.folder;
document.getElementById('dock-runner-name').textContent = dock.runner;

// ---- real mode: the lists and defaults come from the server, and the "simulation" notice goes away
const dockSimEl = document.getElementById('dock-sim');
function onRealMode() {
  const real = realMode();
  dockSimEl.hidden = real;
  // the choice of the last visit comes back when it is still on offer
  if (real) {
    dock.folder = folderList().includes(dockPrefs.folder) ? dockPrefs.folder : folderList()[0] || '';
    dock.runner = runnerList().some((r) => r.ok && r.id === dockPrefs.runner) ? dockPrefs.runner : (runnerList().find((r) => r.ok) || runnerList()[0] || { id: '' }).id;
  } else {
    dock.folder = FOLDERS.includes(dockPrefs.folder) ? dockPrefs.folder : FOLDERS[0];
    dock.runner = ['claude', 'opencode'].includes(dockPrefs.runner) ? dockPrefs.runner : 'claude';
  }
  document.getElementById('dock-folder-name').textContent = dock.folder || '—';
  document.getElementById('dock-runner-name').textContent = dock.runner || '—';
  syncControls();
  if (typeof onContextMode === 'function') onContextMode();
}

// ---- from the rest of the page

// AlifGunadi arrived at a desk (control.js): the conversation opens with that agent as the target.
function onConversationStart(id) {
  dock.answerTask = null;
  addChip(id);
  expandDock();
  dockInput.focus();
}

// "Jawab" on a task that is waiting for input.
function openDockFor(deskId, taskId) {
  dock.answerTask = taskId;
  dock.chips = [deskId];
  renderChips();
  expandDock();
  dockInput.focus();
}

// "/" jumps to the dock from anywhere that is not a text field.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || isTypingTarget(document.activeElement)) return;
  e.preventDefault();
  expandDock();
  dockInput.focus();
});

dockEl.addEventListener('focusout', () => setTimeout(maybeCollapse, 150));

syncControls();
refreshHint();
