'use strict';

// ---------- drawing the scene ----------

function drawAgent(a, p) {
  const role = roleOf(a.id), g = layout.lounge, slot = a.slot >= 0 ? g.slots[a.slot] : null;
  const st = (deskMap.get(a.id) || {}).status || a.status;
  const atDesk = a.s <= 0.5, inLounge = !!slot && !a.st && a.s >= a.total - 0.5;
  const ch = a.chat;
  let pose = 'walk', z = 0, face = 'front', anim = null, side = false, flip = a.flip;
  if (atDesk) {
    pose = 'sit'; z = SEAT; flip = false;
    if (st === 'working') anim = 'type';
    if (P.rot !== 0) { const f = facingOf(0, 1); face = f.face; side = f.side; flip = f.flip; } // the desk's owner faces the desk (+y)
  } else if (inLounge) {
    pose = slot.z > 0 ? 'sit' : 'stand'; z = slot.z; face = slot.face; flip = false;
    anim = slot.anim === 'chat' ? (ch && ch.speak ? 'chat' : null) : slot.anim;
    if (slot.side) { side = true; flip = slot.flipFace; }
    if (P.rot !== 0) {
      const f = slot.side ? facingOf(slot.flipFace ? -1 : 1, 0) : facingOf(0, slot.face === 'back' ? -1 : 1);
      face = f.face; side = f.side; flip = f.flip;
    }
  } else if (a.st) {
    const from = g.slots[a.slot].z, to = g.slots[a.st.to].z;
    z = Math.max(from * Math.max(0, 1 - a.st.p / 14), to * Math.max(0, 1 - (a.st.len - a.st.p) / 14));
  } else if (a.s < 18) {
    z = SEAT * (1 - a.s / 18);
  } else if (slot && slot.z > 0 && a.total - a.s < 18) {
    z = slot.z * (1 - (a.total - a.s) / 18);
  }
  if (a.man) { // AlifGunadi under manual control: walking, or standing and looking where he is heading
    pose = a.man.moving ? 'walk' : 'stand'; z = 0; anim = null; face = 'front'; side = false;
    if (!a.man.moving) { const f = facingOf(a.man.facing[0], a.man.facing[1]); face = f.face; side = f.side; flip = f.flip; } else flip = a.flip;
  }
  const v = pj(a.x, a.y, z);
  drawChar(role, v[0], v[1], {
    pose, face, anim, side, flip, ph: a.s * STRIDE + (a.st ? a.st.p * STRIDE : 0) + (a.man ? a.man.dist * STRIDE : 0), t: animT, seed: a.seed, k: p.k * P.cs,
    status: st, sleepy: atDesk && st === 'idle',
    speak: !!(ch && ch.speak), look: ch ? ch.look : 0, laugh: !!(ch && ch.laugh), nod: !!(ch && ch.nod),
  }, a);
}

// Which way a character looks on screen when it faces a world direction: toward the viewer, away, or sideways (flip = left).
function facingOf(fx, fy) {
  const g = viewDir(fx, fy);
  if (g[1] > 0) return { face: 'front', side: false, flip: false };
  if (g[1] < 0) return { face: 'back', side: false, flip: false };
  return { face: 'front', side: true, flip: g[0] < 0 };
}

function safe(fn) {
  ctx.save();
  try { fn(); } catch (err) { warnOnce(err); } finally { ctx.restore(); }
}

function drawOverlays(cssW) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  shadowK = dpr;
  noShadow();
  ctx.globalAlpha = 1;
  const list = [];
  for (const a of agents.values()) if (isFinite(a.hx) && isFinite(a.hy)) list.push(a);
  list.sort((m, n) => m.hy - n.hy);

  // hovered agent (frontmost under the pointer)
  let hover = null;
  if (mouse) {
    for (const a of list) {
      const r = a.hitR;
      if (r && mouse.x >= r.x && mouse.x <= r.x + r.w && mouse.y >= r.y && mouse.y <= r.y + r.h) {
        if (!hover || a.fy > hover.fy) hover = a;
      }
    }
  }

  const hitOf = (r, ignore) => (list.some((o) => o !== ignore && o.hitR && overlapsRect(r, o.hitR)));
  const draws = [], bubbles = [], tags = [], dots = [];
  const takenTags = [];
  let hoverTag = null;
  const MAX_TAGS = 3;
  // No name labels above characters (walking or hovered): agents away from the desk show only a colour dot.
  const showTag = new Set();

  for (const a of list) {
    const role = roleOf(a.id);
    const cx = Math.max(40, Math.min(a.hx * sc, cssW - 40));
    if (a.s > 0.5) {
      // away from the desk: colour dot unless the agent has a tag
      if (!showTag.has(a)) dots.push(() => {
        circle(a.hx * sc, a.hy * sc - 8, 5, '#ffffff');
        circle(a.hx * sc, a.hy * sc - 8, 3.5, role.color);
      });
      if (a.man && a.man.mode === 'conversing') {
        draws.push(() => speechIcon(cx, a.hy * sc - 60, '💬'));
      } else if (a.chat && a.chat.speak && a.loc === 'in the lounge') {
        const icon = a.chat.icon;
        draws.push(() => speechIcon(cx, a.hy * sc - 60, icon));
      }
      continue;
    }
    const d = deskMap.get(a.id) || {};
    const bx = Math.max(BUBBLE_MAX / 2 + 6, Math.min(a.hx * sc, cssW - BUBBLE_MAX / 2 - 6));
    const y = Math.max(2, a.hy * sc - 6 - 35);
    if (d.status === 'working') bubbles.push(() => queueBadge(bx, y, bubble(d.activity || 'working', bx, y, '#2f6fe0'), a.id));
    else if (d.status === 'waiting') bubbles.push(() => queueBadge(bx, y, bubble(d.activity || 'waiting', bx, y, '#d99a0b', '!', (reduced || Math.floor(animT / 500) % 2 === 0) ? 1 : 0.25, '#a86a00'), a.id));
    else if (d.status === 'done') bubbles.push(() => queueBadge(bx, y, bubble(d.activity || 'done', bx, y, '#1f9d55', '✓', 1, '#157a40'), a.id));
    else if (d.status === 'idle') {
      draws.push(() => {
        const zf = reduced ? 0.3 : (animT / 900 + a.seed) % 1;
        ctx.globalAlpha = 1 - zf;
        ctx.fillStyle = '#4b5563';
        ctx.font = '800 14px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('z', a.hx * sc + 16 + zf * 8, a.hy * sc + 10 - zf * 18);
        ctx.globalAlpha = 1;
      });
    }
  }
  if (focusId) {
    const fa = agents.get(focusId);
    if (fa && isFinite(fa.hx) && isFinite(fa.hy)) {
      const frole = roleOf(fa.id);
      const fx = Math.max(40, Math.min(fa.hx * sc, cssW - 40));
      tags.push(() => tag(frole, fx, Math.max(22, fa.hy * sc - 44)));
    }
  }
  for (const group of [dots, draws, bubbles, tags]) for (const f of group) safe(f);
  if (hoverTag) safe(hoverTag);
  const cursor = canvasCursor();
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
}

function measureStage() {
  const cs = getComputedStyle(stage);
  availW = Math.max(0, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  availH = Math.max(0, stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
  layoutDirty = true;
  requestRender();
}
// A resize clears the canvas, so redraw right away instead of waiting for an animation frame
// (frames do not run for a covered window, and with reduced motion nothing else would redraw it).
const onStageResize = () => { measureStage(); renderNow(); };
if (window.ResizeObserver) new ResizeObserver(onStageResize).observe(stage);
window.addEventListener('resize', onStageResize);

// Make sure the web font is ready for canvas text (frames redraw continuously, so it appears once loaded).
if (document.fonts && document.fonts.load) {
  Promise.all([document.fonts.load('700 13px Nunito'), document.fonts.load('800 13px Nunito')]).then(renderNow, () => { });
}

let warned = false;
function warnOnce(err) {
  if (warned) return;
  warned = true;
  console.error('Canvas draw error', err);
}

let sizedKey = '';
function render(t) {
  if (availW == null) measureStage();
  // the isometric floor plan at every width: it is scaled to fit the stage (a phone shows the whole floor, small), and the camera turns on it
  const cols = 0;
  if (layoutDirty || !layout || layout.rot !== camera.rot || layout.walls !== camera.walls) {
    layout = buildLayout(desks, cols);
    layoutDirty = false;
    cameraLayoutChanged(); // the controls depend on the layout mode
  }
  const sw = layout.sceneW;
  let cssW;
  if (cols) {
    cssW = Math.round(Math.max(sw, Math.min(availW, sw * 1.6)) * camera.zoom);
  } else {
    // wide: fit the projected bounding box into the stage (width and height) so nothing scrolls
    const byW = availW / sw;
    const byH = availH > TOP_PAD + 200 ? (availH - TOP_PAD) / layout.sceneH : Infinity;
    cssW = Math.round(sw * Math.max(MIN_FIT, Math.min(byW, byH, 1.35)) * camera.zoom); // zoom is a multiple of the fit-to-window size
  }
  if (cssW <= 0) return;
  sc = cssW / sw;
  const cssH = Math.round(layout.sceneH * sc + TOP_PAD);
  dpr = Math.max(1, window.devicePixelRatio || 1);
  if (cssW * cssH * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const key = cssW + 'x' + cssH;
  if (key !== sizedKey) {
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px'; sizedKey = key;
    restoreCenter(); // keep the middle of what the user was looking at after a turn or zoom
    drawMinimap();
  }
  P.ox = layout.ox;
  P.oy = layout.oy + TOP_PAD / sc;

  const gap = lastT ? t - lastT : 0;
  const dt = Math.min(100, Math.max(0, gap)) / 1000;
  lastT = t;
  animT = reduced ? 0 : t;
  try { updateAgents(dt, t, gap > 2000); } catch (err) { warnOnce(err); }
  try { computeChat(animT); } catch (err) { warnOnce(err); }
  refreshAria();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0);
  noShadow();
  ctx.globalAlpha = 1;
  for (const f of layout.floors) safe(f);
  for (const f of layout.ground) safe(f);

  const list = layout.items.slice();
  for (const a of agents.values()) {
    const p = layout.byId.get(a.id);
    if (!p) continue;
    const f = pjr(a.x, a.y, 0), ck = p.k * P.cs;
    const vc = viewXY(a.x, a.y), vr = viewRect(a.x - 8, a.y - 5, a.x + 8, a.y + 5);
    list.push({
      x0: vr[0], x1: vr[2], y0: vr[1], y1: vr[3], k: P.s > 0 ? vc[0] + vc[1] : vc[1],
      sb: [f[0] - 22 * ck, f[1] - 70 * ck - 12, f[0] + 22 * ck, f[1] + 10], draw: () => drawAgent(a, p),
    });
  }
  for (const it of depthSort(list)) safe(it.draw);
  for (const f of layout.tags) safe(f); // desk name pills (camera turns other than 0)
  safe(() => drawNavMarks(t));
  drawOverlays(cssW);
  safe(drawHoverTip);
}

// Render loop: runs only while the page is visible. With reduced motion nothing animates, so it draws on demand
// (a state change, resize, pointer move) plus a slow tick for the idle-to-lounge timer. When no agent is working
// or walking the animation is light, so it is drawn at about 30 fps; otherwise at most about 60 fps.
let rafId = 0, lastDraw = 0, dirty = true, lastBusy = true;
function requestRender() {
  dirty = true;
  if (!booted) return;
  if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame);
}
function renderNow() {
  if (!booted || document.hidden) { requestRender(); return; }
  dirty = true;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  frame(performance.now());
}
function isBusy() {
  for (const a of agents.values()) if (a.dir !== 0 || a.st || a.status === 'working') return true;
  return false;
}
function frame(t) {
  rafId = 0;
  if (!booted || document.hidden) return;
  applyPending();
  if (reduced && !dirty) return;
  // at most ~60 fps even on a 120/144 Hz display, ~30 fps when nothing is moving
  if (!reduced && t - lastDraw < (lastBusy || dirty ? 15 : 30)) { rafId = requestAnimationFrame(frame); return; }
  dirty = false;
  lastDraw = t;
  try { render(t); } catch (err) { warnOnce(err); }
  lastBusy = isBusy();
  if (!reduced) rafId = requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  } else {
    lastT = 0; // the gap while hidden must not become one huge animation step
    requestRender();
  }
});
setInterval(() => { if (reduced) requestRender(); }, 1000);

function orderDesks(map) {
  const known = Object.keys(ROLES).filter((id) => hasOwn(map, id) && map[id]).map((id) => map[id]);
  const guests = Object.values(map).filter((d) => d && !hasOwn(ROLES, d.id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return known.concat(guests);
}
