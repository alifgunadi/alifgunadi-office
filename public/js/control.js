'use strict';

// ---------- AlifGunadi: click the floor to walk, a desk to talk, his own desk to sit down again ----------
// The state lives in the agent record of the main desk as `a.man` while he is under manual control:
//   mode   'walking' (on his way), 'standing' (arrived on the floor) or 'conversing' (arrived at another desk)
//   path   { pts, cum, total } in world coordinates, d = distance walked along it, dist = distance for the step animation
//   target { kind: 'point' | 'desk' | 'own', x, y, id }
// With no `a.man` the normal automatic behaviour (desk <-> lounge) applies. All of this is local to the page: the server does not know.

const MAIN_ID = OfficeRoles.MAIN_DESK;
const BLOCKED_TEXT = 'Area ini tidak bisa dilewati.';
const NO_ROUTE_TEXT = 'Tidak ada jalan ke sana.';
const TOAST_MS = 2200, FLASH_MS = 700;

const toastEl = document.getElementById('toast');
let toastTimer = 0;
let hover = null;             // what the pointer is over: { kind: 'desk' | 'own' | 'floor' | 'blocked', id, x, y }
let flash = null;             // a red ring where a click was refused: { x, y, t0 }
let suppressClick = false;    // set by camera.js after a drag, so letting go of a pan is not a click

const mainAgent = () => agents.get(MAIN_ID);
const layoutKey = (L) => L.cols + ':' + L.W + 'x' + L.H; // the world only changes with these, not when the camera turns

// ---- geometry of a desk (world coordinates, same offsets as addDesk in layout.js)

const deskSeat = (p) => [p.x + CX * p.k, p.y + 78 * p.k];   // where the owner sits
const deskFront = (p) => [p.x + CX * p.k, p.y + 138 * p.k]; // the walkway in front of the desk, where a visitor stands

function deskFloorRegion(p) {
  return [p.x + (CX - 80) * p.k, p.y + 50 * p.k, p.x + (CX + 80) * p.k, p.y + 152 * p.k]; // chair to the walkway in front (where a visitor stands)
}

// Screen box (css px) of the whole desk volume with the person at it, for clicks on the monitor or the character.
function deskScreenBox(p) {
  const x0 = p.x + (CX - 75) * p.k, x1 = p.x + (CX + 75) * p.k, y0 = p.y + 56 * p.k, y1 = p.y + 124 * p.k;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [0, 70]) {
    const q = pj(x, y, z);
    u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]);
  }
  return [u0 * sc, v0 * sc, u1 * sc, v1 * sc];
}

// In front of what: larger = nearer the viewer.
function deskDepth(p) {
  const v = viewXY(p.x + CX * p.k, p.y + 100 * p.k);
  return P.s > 0 ? v[0] + v[1] : v[1];
}

// Is a screen point inside the projection of a box (its convex hull)? The box is a world rectangle with a height.
function inBoxHull(cx, cy, x0, y0, x1, y1, h) {
  const pts = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [0, h]) { const q = pj(x, y, z); pts.push([q[0] * sc, q[1] * sc]); }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  for (let i = 0; i < hull.length; i++) { if (cross(hull[i], hull[(i + 1) % hull.length], [cx, cy]) < 0) return false; }
  return true;
}

// The nearest wall whose picture covers the point, or null. A wall hides the floor behind it, so it is not floor you can walk to.
function wallAt(cx, cy) {
  let best = null, bestDepth = -Infinity;
  for (const it of layout.items) {
    if (!it.wall || !inBoxHull(cx, cy, it.wr[0], it.wr[1], it.wr[2], it.wr[3], it.h)) continue;
    const v = viewXY((it.wr[0] + it.wr[2]) / 2, (it.wr[1] + it.wr[3]) / 2), depth = P.s > 0 ? v[0] + v[1] : v[1];
    if (depth > bestDepth) { bestDepth = depth; best = it; }
  }
  return best ? { it: best, depth: bestDepth } : null;
}

// What is under the pointer (css px relative to the canvas)? Desks win over plain floor; clicks on the floor in front of a desk,
// on its plaque and on the character or monitor above it all count as the desk. A wall in front of something hides it.
function hitTest(cx, cy) {
  if (!layout || !layout.places.length) return null;
  const w = unproject(cx / sc, cy / sc);
  let onFloor = null, onVolume = null;
  for (const p of layout.places) {
    const r = deskFloorRegion(p);
    if (w[0] >= r[0] && w[0] <= r[2] && w[1] >= r[1] && w[1] <= r[3]) { if (!onFloor || deskDepth(p) > deskDepth(onFloor)) onFloor = p; }
    const b = deskScreenBox(p);
    if (cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]) { if (!onVolume || deskDepth(p) > deskDepth(onVolume)) onVolume = p; }
  }
  const p = onFloor || onVolume;
  const wall = wallAt(cx, cy);
  // a desk on the floor region is in front of anything drawn over it only if it is nearer than the wall
  if (p && (!wall || (onFloor && deskDepth(p) > wall.depth) || (!onFloor && deskDepth(p) > wall.depth))) return { kind: p.id === MAIN_ID ? 'own' : 'desk', id: p.id, x: w[0], y: w[1] };
  if (wall) return { kind: 'blocked', x: w[0], y: w[1] };
  const ok = navFree(layoutNav(layout), w[0], w[1]);
  return { kind: ok ? 'floor' : 'blocked', x: w[0], y: w[1] };
}

// ---- feedback

function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, TOAST_MS);
}

function refuse(w, text) {
  flash = { x: w[0], y: w[1], t0: performance.now() };
  showToast(text);
  setTimeout(requestRender, FLASH_MS + 50); // clears the ring when nothing else is redrawing (reduced motion)
  requestRender();
}

function canvasCursor() {
  if (drag && drag.moved) return 'grabbing';
  if (!hover) return '';
  return hover.kind === 'blocked' ? 'not-allowed' : 'pointer';
}

// ---- commands

function beginManual(a) {
  if (a.man) return a.man;
  cancelStroll(a);
  releaseSlot(a);
  a.route = null; a.total = 0; a.prefix = 0;
  a.s = 1;            // anything above 0.5 means "away from the desk": the chair slides out, the bubble gives way to a dot
  a.man = { mode: 'standing', path: null, d: 0, dist: 0, moving: false, target: null, facing: [0, 1], last: performance.now(), key: layoutKey(layout) };
  return a.man;
}

function pathTo(a, x, y) {
  const found = navFindPath(layoutNav(layout), a.x, a.y, x, y);
  if (!found) return null;
  const cum = [0];
  for (let i = 1; i < found.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(found.pts[i][0] - found.pts[i - 1][0], found.pts[i][1] - found.pts[i - 1][1]));
  return { pts: found.pts, cum, total: cum[cum.length - 1] };
}

function arriveFacing(path) {
  const n = path.pts.length;
  if (n < 2) return [0, 1];
  const dx = path.pts[n - 1][0] - path.pts[n - 2][0], dy = path.pts[n - 1][1] - path.pts[n - 2][1];
  return Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy) || 1];
}

// Start walking to a target. Returns false when there is no way there.
function sendMain(kind, x, y, id) {
  const a = mainAgent();
  if (!a || !layout || !layout.byId.get(MAIN_ID)) return false;
  const path = pathTo(a, x, y);
  if (!path) return false;
  const m = beginManual(a);
  m.path = path; m.d = 0; m.target = { kind, x, y, id }; m.mode = 'walking'; m.moving = true; m.last = performance.now();
  if (reduced) finishWalk(a); // no walking with reduced motion: he is simply there
  requestRender();
  return true;
}

function commandMove(x, y) {
  return sendMain('point', x, y);
}

function commandTalk(id) {
  const p = layout && layout.byId.get(id);
  if (!p) return false;
  const a = mainAgent(), m = a && a.man;
  if (m && m.mode === 'conversing' && m.target.id === id) { m.last = performance.now(); return true; } // already there
  const f = deskFront(p);
  return sendMain('desk', f[0], f[1], id);
}

function commandHome() {
  const p = layout && layout.byId.get(MAIN_ID);
  if (!p) return false;
  const a = mainAgent();
  if (!a.man) return true; // already seated
  const s = deskSeat(p);
  return sendMain('own', s[0], s[1], MAIN_ID);
}

// One entry for the keyboard list of agents: the same as clicking that desk.
function commandForDesk(id) {
  const ok = id === MAIN_ID ? commandHome() : commandTalk(id);
  if (!ok) showToast(NO_ROUTE_TEXT);
  return ok;
}

function stopMain() {
  const a = mainAgent();
  if (a && a.man && a.man.mode === 'walking') {
    a.man.mode = 'standing'; a.man.moving = false; a.man.target = { kind: 'point', x: a.x, y: a.y };
    a.man.last = performance.now();
    requestRender();
  }
}

// ---- per-frame update, called from updateAgents (agents.js) while a.man exists. Returns true if it handled the agent.

function finishWalk(a) {
  const m = a.man, last = m.path.pts[m.path.pts.length - 1];
  a.x = last[0]; a.y = last[1];
  m.d = m.path.total; m.moving = false; m.last = performance.now();
  m.facing = arriveFacing(m.path);
  const t = m.target;
  if (t.kind === 'own') {
    a.man = null; a.s = 0; // seated: the normal behaviour takes over again (the chair slides back in)
    announce('AlifGunadi kembali ke mejanya');
    return;
  }
  if (t.kind === 'desk') {
    m.mode = 'conversing';
    m.facing = [0, -1]; // looks at the owner behind the desk
    announce('AlifGunadi menghampiri ' + roleOf(t.id).label);
    if (typeof onConversationStart === 'function') onConversationStart(t.id);
  } else {
    m.mode = 'standing';
  }
}

function updateMain(a, dt, now) {
  const m = a.man, L = layout;
  if (m.key !== layoutKey(L)) { a.man = null; a.s = 0; return false; } // the floor was rebuilt (window resized across a layout change): back to the desk
  if (m.mode === 'conversing' && !L.byId.get(m.target.id)) { m.mode = 'standing'; } // the guest left
  if (m.mode === 'walking') {
    m.d = Math.min(m.path.total, m.d + WALK_SPEED * dt);
    const q = samplePath(m.path.pts, m.path.cum, m.d);
    a.x = q.x; a.y = q.y;
    const du = screenDu(q.dx, q.dy);
    if (Math.abs(du) > 0.01) a.flip = du < 0;
    m.dist += WALK_SPEED * dt;
    m.last = now;
    if (m.d >= m.path.total) finishWalk(a);
    if (!a.man) return false;
  } else if (now - m.last >= LEAVE_GRACE_MS) {
    commandHome(); // like everyone else, he goes back to his desk after ten quiet minutes
    m.last = now;
  }
  a.chair = reduced ? 1 : Math.max(0, Math.min(1, a.chair + (1 - a.chair) * Math.min(1, dt * 8)));
  const mm = a.man;
  if (mm) a.loc = mm.mode === 'walking' ? 'walking' : mm.mode === 'conversing' ? 'talking to ' + roleOf(mm.target.id).label : 'on the floor';
  return true;
}

// ---- drawing: the target ring, the remaining path, the desk under the pointer, a refused click. Called with the scene transform.

function ringPoints(x, y, r) {
  const pts = [];
  for (let i = 0; i < 28; i++) { const t = (i / 28) * TAU; pts.push(pj(x + Math.cos(t) * r, y + Math.sin(t) * r, 0.4)); }
  return pts;
}

function strokeRing(x, y, r, color, width, fill) {
  const pts = ringPoints(x, y, r);
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.strokeStyle = color; ctx.lineWidth = width / sc; ctx.stroke();
}

function drawNavMarks(now) {
  if (!layout) return;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // the desk under the pointer
  if (hover && (hover.kind === 'desk' || hover.kind === 'own')) {
    const p = layout.byId.get(hover.id);
    if (p) {
      const x0 = p.x + (CX - 78) * p.k, x1 = p.x + (CX + 78) * p.k, y0 = p.y + 54 * p.k, y1 = p.y + 128 * p.k;
      const pts = [pj(x0, y0, 0.4), pj(x1, y0, 0.4), pj(x1, y1, 0.4), pj(x0, y1, 0.4)];
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.closePath();
      ctx.fillStyle = 'rgba(37,99,235,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(37,99,235,0.85)'; ctx.lineWidth = 2 / sc; ctx.stroke();
    }
  } else if (hover && hover.kind === 'floor') {
    strokeRing(hover.x, hover.y, 9, 'rgba(37,99,235,0.55)', 1.5);
  }
  // his way and where it ends
  const a = mainAgent();
  if (a && a.man) {
    const m = a.man;
    if (m.mode === 'walking') {
      const rest = [[a.x, a.y]];
      for (let i = 0; i < m.path.pts.length; i++) if (m.path.cum[i] > m.d) rest.push(m.path.pts[i]);
      ctx.beginPath();
      rest.forEach((q, i) => { const s = pj(q[0], q[1], 0.5); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
      ctx.setLineDash([7 / sc, 6 / sc]);
      ctx.strokeStyle = 'rgba(37,99,235,0.9)'; ctx.lineWidth = 2.4 / sc; ctx.stroke();
      ctx.setLineDash([]);
    }
    if (m.target && m.target.kind !== 'own') strokeRing(m.mode === 'walking' ? m.target.x : a.x, m.mode === 'walking' ? m.target.y : a.y, 13, 'rgba(37,99,235,0.95)', 2.4, 'rgba(37,99,235,0.14)');
  }
  // a refused click
  if (flash) {
    const age = now - flash.t0;
    if (age > FLASH_MS) flash = null;
    else strokeRing(flash.x, flash.y, reduced ? 12 : 8 + 8 * (age / FLASH_MS), 'rgba(210,60,60,' + (reduced ? 1 : 1 - age / FLASH_MS) + ')', 2.6, 'rgba(210,60,60,0.12)');
  }
  ctx.restore();
}

// The tooltip of the desk under the pointer, in css px (called after the other overlays).
function drawHoverTip() {
  if (!hover || (hover.kind !== 'desk' && hover.kind !== 'own') || !layout) return;
  const p = layout.byId.get(hover.id);
  if (!p) return;
  const d = deskMap.get(hover.id) || {};
  const text = hover.kind === 'own' ? 'Kembali ke meja CEO' : roleOf(hover.id).label + ' · ' + (d.status || 'idle');
  const c = pj(p.x + CX * p.k, p.y + 90 * p.k, 74);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '700 12px ' + FONT;
  const w = Math.ceil(ctx.measureText(text).width) + 20, h = 26;
  const x = Math.max(4, Math.min(c[0] * sc - w / 2, canvas.clientWidth - w - 4)), y = Math.max(4, c[1] * sc - h - 6);
  rr(x, y, w, h, 8, '#1f2937');
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 10, y + h / 2 + 1);
}

// ---- pointer

canvas.addEventListener('pointermove', (e) => {
  if (drag && drag.moved) return;
  const r = canvas.getBoundingClientRect();
  const next = hitTest(e.clientX - r.left, e.clientY - r.top);
  const same = hover && next && hover.kind === next.kind && hover.id === next.id && (next.kind !== 'floor' || (Math.abs(hover.x - next.x) < 2 && Math.abs(hover.y - next.y) < 2));
  hover = next;
  if (!same) requestRender();
});
canvas.addEventListener('pointerleave', () => { hover = null; requestRender(); });

canvas.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; return; }
  const r = canvas.getBoundingClientRect();
  const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (!hit) return;
  if (hit.kind === 'blocked') return refuse([hit.x, hit.y], BLOCKED_TEXT);
  let ok;
  if (hit.kind === 'floor') ok = commandMove(hit.x, hit.y);
  else if (hit.kind === 'own') ok = commandHome();
  else ok = commandTalk(hit.id);
  if (!ok) refuse([hit.x, hit.y], hit.kind === 'floor' ? BLOCKED_TEXT : NO_ROUTE_TEXT);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && !isTypingTarget(document.activeElement)) stopMain();
});
