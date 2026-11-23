'use strict';

// ---------- tablet and phone: bottom sheet, task position, zone legend, menu, desk chip, reduced motion ----------
// The layouts themselves are CSS (app.css, max-width 1100px and 900px). This file only adds what CSS cannot: the open/closed state of the
// sheet, the "n / total" of the task cards, the folded legend, the menu that replaces the buttons of the top bar, and the desk picker.

const mqTablet = window.matchMedia ? window.matchMedia('(max-width: 1100px)') : { matches: false };
const mqPhone = window.matchMedia ? window.matchMedia('(max-width: 900px)') : { matches: false };
const onMq = (mq, fn) => { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); };

// ---- bottom sheet (phone): the side panel with its tabs as a peek, opened by the grabber or by choosing a tab
const sheetEl = document.getElementById('side-panel');
const sheetBtn = document.getElementById('sheet-toggle');

function setSheet(open, { focus = false } = {}) {
  sheetEl.classList.toggle('is-open', open);
  if (typeof updateTaskPos === 'function') updateTaskPos();
  sheetBtn.setAttribute('aria-expanded', String(open));
  sheetBtn.setAttribute('aria-label', open ? 'Tutup panel tugas dan aktivitas' : 'Buka panel tugas dan aktivitas');
  if (focus) sheetBtn.focus();
}
sheetBtn.addEventListener('click', () => setSheet(!sheetEl.classList.contains('is-open')));
for (const tab of tabButtons) tab.addEventListener('click', () => { if (mqPhone.matches) setSheet(true); });
sheetEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mqPhone.matches && sheetEl.classList.contains('is-open')) { e.preventDefault(); setSheet(false, { focus: true }); }
});
onMq(mqPhone, () => { if (!mqPhone.matches) setSheet(false); updateTaskPos(); });

// ---- a toolbar floating over the page: iPhone Safari (iOS 26) draws its toolbar over the bottom of a page that is as tall as the screen,
// so the peek of the sheet would sit under it. Keep it clear then. With the older bars the page is shorter than the screen: nothing to do.
const BAR_CLEAR_PX = 88; // the floating toolbar of iPhone 11: its top edge is about 82px above the bottom of the screen, plus a little air
function updateBarClear() {
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  const portrait = window.innerHeight > window.innerWidth;
  const fullHeight = !!window.screen && window.innerHeight >= window.screen.height - 120;
  document.documentElement.style.setProperty('--bar-clear', (iphone && portrait && fullHeight && mqPhone.matches ? BAR_CLEAR_PX : 0) + 'px');
}
updateBarClear();
window.addEventListener('resize', updateBarClear);

// ---- dragging the sheet: swipe the grabber or the tab bar up to open it and down to close it (a plain tap still works as before).
// The sheet follows the finger and, on release, goes to the nearer end (or the way a quick flick was going). The touch-action of the
// two grab areas is none (app.css), so the browser does not scroll or pull to refresh instead. Only the grabber and the tabs start a
// drag: everything below them keeps its own scrolling.
const DRAG_START_PX = 8; // below this a press is a tap, not a drag
const FLICK_PX_PER_MS = 0.5;
const sheetGrabAreas = [sheetBtn, sheetEl.querySelector('.tabs')].filter(Boolean);
let sheetDrag = null; // { id, y0, offset0, closedAt, offset, moved, lastY, lastT, v }
let sheetSwallowClickUntil = 0;

// How far down the closed sheet sits, in pixels (the sheet is as tall as when open, minus the peek that stays visible).
function sheetClosedOffset() {
  const cs = getComputedStyle(sheetEl);
  const peek = (parseFloat(cs.getPropertyValue('--peek-base')) || 108) + (parseFloat(cs.getPropertyValue('--bar-clear')) || 0);
  return Math.max(0, sheetEl.offsetHeight - peek);
}

function sheetDragMove(e) {
  const d = sheetDrag;
  if (!d || e.pointerId !== d.id) return;
  const dy = e.clientY - d.y0;
  if (!d.moved) {
    if (Math.abs(dy) < DRAG_START_PX) return;
    d.moved = true;
    sheetEl.classList.add('is-dragging');
  }
  d.offset = Math.min(d.closedAt, Math.max(0, d.offset0 + dy));
  sheetEl.style.transform = 'translateY(' + d.offset + 'px)';
  const now = performance.now();
  if (now > d.lastT) d.v = (e.clientY - d.lastY) / (now - d.lastT);
  d.lastY = e.clientY;
  d.lastT = now;
  e.preventDefault();
}

function sheetDragEnd(e) {
  const d = sheetDrag;
  if (!d || e.pointerId !== d.id) return;
  sheetDrag = null;
  window.removeEventListener('pointermove', sheetDragMove);
  window.removeEventListener('pointerup', sheetDragEnd);
  window.removeEventListener('pointercancel', sheetDragEnd);
  if (!d.moved) return; // a tap: the click that follows toggles or opens as usual
  const open = Math.abs(d.v) > FLICK_PX_PER_MS ? d.v < 0 : d.offset < d.closedAt / 2;
  sheetEl.classList.remove('is-dragging');
  sheetEl.style.transform = ''; // back to the CSS position of the new state, which animates from where the finger let go
  setSheet(open);
  sheetSwallowClickUntil = Date.now() + 400; // the click that ends a drag must not toggle the sheet again
}

for (const area of sheetGrabAreas) {
  area.addEventListener('pointerdown', (e) => {
    if (!mqPhone.matches || sheetDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const closedAt = sheetClosedOffset();
    const offset0 = sheetEl.classList.contains('is-open') ? 0 : closedAt;
    sheetDrag = { id: e.pointerId, y0: e.clientY, offset0, closedAt, offset: offset0, moved: false, lastY: e.clientY, lastT: performance.now(), v: 0 };
    window.addEventListener('pointermove', sheetDragMove, { passive: false });
    window.addEventListener('pointerup', sheetDragEnd);
    window.addEventListener('pointercancel', sheetDragEnd);
  });
}
sheetEl.addEventListener('click', (e) => {
  if (Date.now() < sheetSwallowClickUntil) { e.stopPropagation(); e.preventDefault(); }
}, true);

// ---- "n / total" under the task cards while they scroll sideways (tablet)
const taskPosEl = document.getElementById('task-pos');
let taskPosTimer = 0;

function updateTaskPos() {
  const cards = [...taskListEl.querySelectorAll('.task-card')];
  // phone: the closed sheet shows only the grabber and the tabs (the count is on the Tasks tab), so there is no hint to show;
  // tablet: "n / total" while the cards scroll sideways
  if (mqPhone.matches) {
    taskPosEl.hidden = true;
    return;
  }
  const show = mqTablet.matches && cards.length > 0;
  taskPosEl.hidden = !show;
  if (!show) return;
  let best = 0, dist = Infinity;
  cards.forEach((c, i) => { const d = Math.abs(c.offsetLeft - taskListEl.offsetLeft - taskListEl.scrollLeft); if (d < dist) { dist = d; best = i; } });
  const atEnd = taskListEl.scrollLeft + taskListEl.clientWidth >= taskListEl.scrollWidth - 2;
  setText(taskPosEl, (atEnd ? cards.length : best + 1) + ' / ' + cards.length);
}
const updateTaskPosSoon = () => { clearTimeout(taskPosTimer); taskPosTimer = setTimeout(updateTaskPos, 120); }; // announced once scrolling settles
taskListEl.addEventListener('scroll', updateTaskPosSoon, { passive: true });
new MutationObserver(updateTaskPosSoon).observe(taskListEl, { childList: true });
onMq(mqTablet, updateTaskPos);

// ---- zone legend folded into one chip (phone)
const legendBtn = document.getElementById('legend-toggle');
const legendEl = document.getElementById('legend');
function setLegend(open) {
  legendEl.classList.toggle('is-open', open);
  legendBtn.setAttribute('aria-expanded', String(open));
}
legendBtn.addEventListener('click', () => setLegend(!legendEl.classList.contains('is-open')));
document.addEventListener('mousedown', (e) => { if (legendEl.classList.contains('is-open') && !legendEl.contains(e.target) && !legendBtn.contains(e.target)) setLegend(false); });
legendBtn.addEventListener('keydown', (e) => { if (e.key === 'Escape') setLegend(false); });
onMq(mqPhone, () => setLegend(false));

// ---- "Fokus ke meja": a row of desk chips instead of tapping a small desk (phone)
const focusChips = document.getElementById('focus-chips');
const canvasEl = document.getElementById('office');

function focusDesk(id) {
  commandForDesk(id); // the same as clicking that desk: the walk and the conversation
  const p = layout && layout.byId.get(id);
  if (!p) return;
  const b = deskScreenBox(p);
  const c = canvasEl.getBoundingClientRect(), s = stage.getBoundingClientRect();
  const x = (b[0] + b[2]) / 2 + c.left - s.left + stage.scrollLeft;
  const y = (b[1] + b[3]) / 2 + c.top - s.top + stage.scrollTop;
  stage.scrollTo({ left: Math.max(0, x - stage.clientWidth / 2), top: Math.max(0, y - stage.clientHeight / 2), behavior: reduced ? 'auto' : 'smooth' });
}

let focusSig = '';
// One chip per desk, rebuilt when the set of desks changes (called from rebuildDesks in net.js). The chip of the main desk says it is his own.
function syncFocusChips() {
  const sig = desks.map((d) => d.id).join('|');
  if (sig === focusSig) return;
  focusSig = sig;
  focusChips.textContent = '';
  for (const d of desks) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip focus-chip';
    b.dataset.desk = d.id;
    b.textContent = nameOf(d.id);
    if (d.id === MAIN_ID) b.setAttribute('aria-label', nameOf(d.id) + ' (meja sendiri)');
    b.addEventListener('click', () => focusDesk(d.id));
    li.append(b);
    focusChips.append(li);
  }
}

// ---- reduced motion chosen on the page (on top of the system setting)
const MOTION_OVERRIDE_NOTE = 'Gerak berkurang';
function userReducesMotion() { try { return localStorage.getItem(MOTION_KEY) === '1'; } catch { return false; } }

// ---- menu of the top bar (phone): the controls that no longer fit
const menuBtn = document.getElementById('btn-menu');
const menuList = document.getElementById('menu-pop');
const aboutDlg = document.getElementById('about-dialog');

function closeMenu(focus) {
  menuList.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
  if (focus) menuBtn.focus();
}

function menuItem(label, onClick, { checked, danger } = {}) {
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-item' + (danger ? ' is-danger' : '');
  b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
  if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
  b.textContent = label;
  b.addEventListener('click', onClick);
  li.append(b);
  menuList.append(li);
  return b;
}

// Settings, Restart and Stop live in the gear menu only (below), so this menu has what the gear does not.
function buildMenu() {
  menuList.textContent = '';
  menuItem('Folder & Runner', () => { closeMenu(false); setDockState('expanded'); document.getElementById('dock-folder').focus(); });
  menuItem(MOTION_OVERRIDE_NOTE, () => { setUserReduce(!userReducesMotion()); buildMenu(); menuList.querySelector('[aria-checked]').focus(); }, { checked: userReducesMotion() });
  menuItem('Tentang', () => { closeMenu(false); aboutDlg.showModal(); });
}

function openMenu() {
  buildMenu();
  menuList.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  menuList.querySelector('.menu-item').focus();
}

menuBtn.addEventListener('click', () => (menuList.hidden ? openMenu() : closeMenu(true)));
// Arrow keys, Home/End, Escape and Tab for a menu (the hamburger menu and the gear menu share it).
function menuKeys(list, close) {
  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') close(false);
  });
}
menuKeys(menuList, closeMenu);
document.addEventListener('mousedown', (e) => { if (!menuList.hidden && !menuList.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(false); });
onMq(mqPhone, () => closeMenu(false));

document.getElementById('about-close').addEventListener('click', () => aboutDlg.close());
aboutDlg.addEventListener('close', () => { if (document.contains(menuBtn) && mqPhone.matches) menuBtn.focus(); });
aboutDlg.addEventListener('mousedown', (e) => { if (e.target === aboutDlg) aboutDlg.close(); });

// ---- gear menu (every width): Folder induk (the settings dialog), Restart and Stop. The actions themselves are in net.js and settings.js.
const gearBtn = document.getElementById('btn-settings');
const gearList = document.getElementById('gear-pop');
const gearItems = [...gearList.children];

function closeGear(focus) {
  gearList.hidden = true;
  gearList.replaceChildren(...gearItems); // back from the Stop question
  gearBtn.setAttribute('aria-expanded', 'false');
  if (focus) gearBtn.focus();
}

function openGear() {
  gearList.hidden = false;
  gearBtn.setAttribute('aria-expanded', 'true');
  gearList.querySelector('button').focus();
}

// Phone: Stop asks first, because it ends the office for every session until the next start (called by the Stop item, see net.js).
function askStop() {
  if (gearList.hidden) { gearList.hidden = false; gearBtn.setAttribute('aria-expanded', 'true'); }
  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const box = document.createElement('div');
  box.className = 'confirm-row';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Konfirmasi Stop');
  const text = document.createElement('span');
  text.textContent = 'Hentikan server? Tugas yang berjalan juga berhenti.';
  const row = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Batal';
  cancel.addEventListener('click', () => { gearList.replaceChildren(...gearItems); document.getElementById('btn-stop').focus(); });
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn--danger';
  ok.textContent = 'Stop';
  ok.addEventListener('click', () => { closeGear(false); stopServer(); });
  row.append(cancel, ok);
  box.append(text, row);
  li.append(box);
  gearList.replaceChildren(li);
  cancel.focus();
}

gearBtn.addEventListener('click', () => (gearList.hidden ? openGear() : closeGear(true)));
document.getElementById('gear-folder').addEventListener('click', () => { closeGear(false); openSettings(gearBtn); });
gearList.addEventListener('click', (e) => {
  const b = e.target.closest ? e.target.closest('button') : null;
  if (!b || b.closest('.confirm-row') || (b.id === 'btn-stop' && mqPhone.matches)) return; // the Stop question keeps the menu open
  closeGear(false);
});
menuKeys(gearList, closeGear);
document.addEventListener('mousedown', (e) => { if (!gearList.hidden && !gearList.contains(e.target) && !gearBtn.contains(e.target)) closeGear(false); });
