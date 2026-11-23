'use strict';

// ---------- camera: turn, zoom, walls, the control card, pan and the minimap ----------

const CAMERA_KEY = 'alifgunadi-office.camera';
const CAMERA_MIN_KEY = 'alifgunadi-office.camera.minimized';
const ZOOMS = [0.8, 1, 1.3];
const WALL_MODES = ['up', 'cut', 'down'];
const WALL_LABELS = { up: 'Naik', cut: 'Potong', down: 'Turun' };
const WALL_NAMES = { up: 'naik (semua dinding)', cut: 'potong (dua dinding belakang)', down: 'turun (tanpa dinding)' };

const cameraEl = document.getElementById('camera');
const cameraBody = document.getElementById('camera-body');
const readoutEl = document.getElementById('camera-readout');
const wallCycleBtn = document.getElementById('cam-walls-cycle');
const minBtn = document.getElementById('camera-min');
const compassEl = document.getElementById('camera-compass');
const zoomRange = document.getElementById('cam-zoom');
const rotateLeftBtn = document.getElementById('cam-left');
const rotateRightBtn = document.getElementById('cam-right');
const zoomOutBtn = document.getElementById('cam-zoom-out');
const zoomInBtn = document.getElementById('cam-zoom-in');
const wallButtons = [...document.querySelectorAll('#camera-walls [role="radio"]')];
const minimapEl = document.getElementById('minimap');
const minimapCtx = minimapEl.getContext('2d');

// Where the middle of the visible part sits inside the scrolled content, to be restored once the canvas has its new size.
let pendingCenter = null;

// ---- saved choices (per browser; everything is wrapped because storage can be blocked or empty)

function loadCamera() {
  try {
    const v = JSON.parse(localStorage.getItem(CAMERA_KEY));
    if (v && [0, 1, 2, 3].includes(v.rot) && ZOOMS.includes(v.zoom) && WALL_MODES.includes(v.walls)) {
      camera.rot = v.rot; camera.zoom = v.zoom; camera.walls = v.walls;
    }
  } catch { /* nothing saved or storage blocked: keep the defaults */ }
}

function saveCamera() {
  try { localStorage.setItem(CAMERA_KEY, JSON.stringify({ rot: camera.rot, zoom: camera.zoom, walls: camera.walls })); } catch { /* storage blocked */ }
}

// ---- changing the camera

function captureCenter() {
  if (stage.scrollWidth > 0 && stage.scrollHeight > 0) {
    pendingCenter = { fx: (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth, fy: (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight };
  }
}

function restoreCenter() {
  if (!pendingCenter) return;
  stage.scrollLeft = Math.max(0, pendingCenter.fx * stage.scrollWidth - stage.clientWidth / 2);
  stage.scrollTop = Math.max(0, pendingCenter.fy * stage.scrollHeight - stage.clientHeight / 2);
  pendingCenter = null;
}

// next: any of { rot, zoom, walls }. Returns true if something changed.
function setCamera(next, { announceIt = true } = {}) {
  const before = { rot: camera.rot, zoom: camera.zoom, walls: camera.walls };
  if (next.rot !== undefined) camera.rot = ((Math.round(next.rot) % 4) + 4) % 4;
  if (next.zoom !== undefined && ZOOMS.includes(next.zoom)) camera.zoom = next.zoom;
  if (next.walls !== undefined && WALL_MODES.includes(next.walls)) camera.walls = next.walls;
  if (camera.rot === before.rot && camera.zoom === before.zoom && camera.walls === before.walls) return false;
  if (camera.rot !== before.rot || camera.zoom !== before.zoom) captureCenter();
  layoutDirty = true;
  saveCamera();
  syncCameraUi();
  if (announceIt) announce('Kamera ' + camera.rot * 90 + ' derajat, zoom ' + Math.round(camera.zoom * 100) + ' persen, dinding ' + WALL_NAMES[camera.walls]);
  renderNow();
  return true;
}

const turnBy = (steps) => setCamera({ rot: camera.rot + steps });
const zoomBy = (steps) => setCamera({ zoom: ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(camera.zoom) + steps))] });
const resetCamera = () => setCamera({ rot: 0, zoom: 1, walls: 'cut' });

// The camera turns at every screen width (the floor plan is isometric on phones and tablets too).
const canTurn = () => true;

// ---- the control card

function syncCameraUi() {
  const turnable = canTurn();
  const shownRot = turnable ? camera.rot : 0;
  setText(readoutEl, shownRot * 90 + '° · ' + Math.round(camera.zoom * 100) + '%');
  setText(wallCycleBtn, 'Dinding: ' + WALL_LABELS[camera.walls]);
  wallCycleBtn.setAttribute('aria-label', 'Mode dinding: ' + WALL_LABELS[camera.walls] + '. Ketuk untuk mengganti');
  compassEl.style.transform = 'rotate(' + (-shownRot * 90) + 'deg)';
  zoomRange.value = String(ZOOMS.indexOf(camera.zoom));
  zoomRange.setAttribute('aria-valuetext', Math.round(camera.zoom * 100) + '%');
  zoomOutBtn.disabled = camera.zoom === ZOOMS[0];
  zoomInBtn.disabled = camera.zoom === ZOOMS[ZOOMS.length - 1];
  for (const b of [rotateLeftBtn, rotateRightBtn, ...wallButtons]) {
    b.setAttribute('aria-disabled', String(!turnable));
    b.classList.toggle('is-disabled', !turnable);
  }
  for (const b of wallButtons) {
    const on = b.dataset.walls === camera.walls;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  drawMinimap();
}

// Called by the renderer whenever it has rebuilt the layout (the layout mode decides whether turning is possible).
function cameraLayoutChanged() {
  syncCameraUi();
}

rotateLeftBtn.addEventListener('click', () => { if (canTurn()) turnBy(-1); });
rotateRightBtn.addEventListener('click', () => { if (canTurn()) turnBy(1); });
zoomOutBtn.addEventListener('click', () => zoomBy(-1));
zoomInBtn.addEventListener('click', () => zoomBy(1));
wallCycleBtn.addEventListener('click', () => setCamera({ walls: WALL_MODES[(WALL_MODES.indexOf(camera.walls) + 1) % WALL_MODES.length] }));
zoomRange.addEventListener('input', () => setCamera({ zoom: ZOOMS[Number(zoomRange.value)] }));

for (const b of wallButtons) {
  b.addEventListener('click', () => { if (canTurn()) setCamera({ walls: b.dataset.walls }); });
  b.addEventListener('keydown', (e) => {
    const i = wallButtons.indexOf(b);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = wallButtons[(i + 1) % wallButtons.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = wallButtons[(i + wallButtons.length - 1) % wallButtons.length];
    if (next) { e.preventDefault(); if (canTurn()) setCamera({ walls: next.dataset.walls }); next.focus(); }
  });
}

// Minimize: the card shrinks to a chip in the same corner (and the choice is remembered).
function setMinimized(min, { focus = false } = {}) {
  cameraEl.classList.toggle('is-min', min);
  cameraBody.hidden = min;
  minBtn.setAttribute('aria-expanded', String(!min));
  minBtn.setAttribute('aria-label', min ? 'Buka kamera' : 'Minimalkan kamera');
  try { localStorage.setItem(CAMERA_MIN_KEY, min ? '1' : '0'); } catch { /* storage blocked */ }
  if (focus) minBtn.focus();
}
minBtn.addEventListener('click', () => setMinimized(!cameraEl.classList.contains('is-min')));

// ---- keyboard shortcuts (Q/E turn, + and - zoom, 0 resets). They are single keys, so they stay out of the way of typing.

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && el.type !== 'range' && el.type !== 'button';
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || isTypingTarget(document.activeElement)) return;
  let handled = true;
  switch (e.key) {
    case 'q': case 'Q': if (canTurn()) turnBy(-1); break;
    case 'e': case 'E': if (canTurn()) turnBy(1); break;
    case '+': case '=': zoomBy(1); break;
    case '-': case '_': zoomBy(-1); break;
    case '0': resetCamera(); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

// ---- pan by dragging (mouse), and the minimap

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  if (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight) return;
  drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false, id: e.pointerId };
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag: keeps clicks on desks working
  if (!drag.moved) { drag.moved = true; requestRender(); } // the cursor is chosen in canvasCursor() (control.js)
  stage.scrollLeft = drag.left - dx;
  stage.scrollTop = drag.top - dy;
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  if (drag.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); requestRender(); } // the click that follows a drag is not a click
  drag = null;
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// Minimap ("PETA"): the floorplan in miniature with the visible part outlined. Drawn on scroll and camera changes, not every frame.
let minimapQueued = false;
function drawMinimap() {
  if (minimapQueued) return;
  minimapQueued = true;
  requestAnimationFrame(() => { minimapQueued = false; paintMinimap(); });
}

function paintMinimap() {
  const overflow = stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1;
  minimapEl.parentElement.hidden = !overflow || !layout;
  if (minimapEl.parentElement.hidden) return;
  const cssW = parseFloat(canvas.style.width) || canvas.clientWidth, cssH = parseFloat(canvas.style.height) || canvas.clientHeight;
  const mw = 160, k = mw / cssW, mh = Math.max(24, Math.round(cssH * k));
  const dprM = Math.max(1, window.devicePixelRatio || 1);
  if (minimapEl.width !== Math.round(mw * dprM) || minimapEl.height !== Math.round(mh * dprM)) {
    minimapEl.width = Math.round(mw * dprM); minimapEl.height = Math.round(mh * dprM);
    minimapEl.style.width = mw + 'px'; minimapEl.style.height = mh + 'px';
  }
  const m = minimapCtx;
  m.setTransform(dprM, 0, 0, dprM, 0, 0);
  m.clearRect(0, 0, mw, mh);
  for (const z of layout.zones) {
    const pts = [pj(z.x, z.y, 0), pj(z.x + z.w, z.y, 0), pj(z.x + z.w, z.y + z.h, 0), pj(z.x, z.y + z.h, 0)];
    m.beginPath();
    pts.forEach((p, i) => (i ? m.lineTo(p[0] * sc * k, p[1] * sc * k) : m.moveTo(p[0] * sc * k, p[1] * sc * k)));
    m.closePath();
    m.fillStyle = z.floor; m.fill();
    m.strokeStyle = z.wall; m.lineWidth = 1; m.stroke();
  }
  // the part of the canvas that is on screen
  const vx = (stage.scrollLeft - canvas.offsetLeft) * k, vy = (stage.scrollTop - canvas.offsetTop) * k;
  m.strokeStyle = '#2563eb'; m.lineWidth = 2;
  m.strokeRect(vx + 1, vy + 1, Math.min(mw, stage.clientWidth * k) - 2, Math.min(mh, stage.clientHeight * k) - 2);
}

stage.addEventListener('scroll', drawMinimap, { passive: true });
window.addEventListener('resize', drawMinimap);

function panFromMinimap(e) {
  const r = minimapEl.getBoundingClientRect();
  const cssW = parseFloat(canvas.style.width) || canvas.clientWidth, k = cssW / r.width;
  stage.scrollLeft = (e.clientX - r.left) * k + canvas.offsetLeft - stage.clientWidth / 2;
  stage.scrollTop = (e.clientY - r.top) * k + canvas.offsetTop - stage.clientHeight / 2;
}
minimapEl.addEventListener('pointerdown', (e) => {
  minimapEl.setPointerCapture(e.pointerId);
  panFromMinimap(e);
  const move = (ev) => panFromMinimap(ev);
  const up = () => { minimapEl.removeEventListener('pointermove', move); minimapEl.removeEventListener('pointerup', up); };
  minimapEl.addEventListener('pointermove', move);
  minimapEl.addEventListener('pointerup', up);
});

// ---- start-up: restore the saved choices (the layout is built on the first frame)

loadCamera();
try { if (localStorage.getItem(CAMERA_MIN_KEY) === '1') setMinimized(true); } catch { /* storage blocked */ }
syncCameraUi();
