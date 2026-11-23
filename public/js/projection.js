'use strict';

// ---------- projection and solids ----------

function setProj(cols) {
  if (cols === 0) { P.c = 0.883; P.s = 0.469; P.K = 1; P.tilt = 0.52; P.zk = 0.95; P.cs = 1.2; }
  else { P.c = 1; P.s = 0; P.K = 1; P.tilt = 0.62; P.zk = 0.9; P.cs = 1.3; }
  // Turning the camera only makes sense in the isometric layout; the stacked rooms are an oblique view.
  setView(cols === 0 ? camera.rot : 0, P.cx || 0, P.cy || 0);
}

// The camera turn: rotate the world by rot quarter turns around (cx, cy), then project as before.
// (dx, dy) -> rot 0: (dx, dy), 1: (-dy, dx), 2: (-dx, -dy), 3: (dy, -dx).
const TURNS = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
function setView(rot, cx, cy) {
  const [a, b, c, d] = TURNS[rot];
  P.rot = rot; P.cx = cx; P.cy = cy;
  P.ra = a; P.rb = b; P.rc = c; P.rd = d;
  P.re = cx - a * cx - b * cy;
  P.rf = cy - c * cx - d * cy;
}

// World -> view coordinates (the frame the original, unturned drawing code works in).
function viewXY(x, y) {
  return P.rot === 0 ? [x, y] : [P.ra * x + P.rb * y + P.re, P.rc * x + P.rd * y + P.rf];
}
// A direction (no translation).
function viewDir(dx, dy) {
  return P.rot === 0 ? [dx, dy] : [P.ra * dx + P.rb * dy, P.rc * dx + P.rd * dy];
}
// Axis-aligned rectangle (stays axis-aligned under quarter turns).
function viewRect(x0, y0, x1, y1) {
  if (P.rot === 0) return [x0, y0, x1, y1];
  const p = viewXY(x0, y0), q = viewXY(x1, y1);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
}
// Screen-horizontal component of a world direction (positive = to the right on screen).
function screenDu(dx, dy) {
  const v = viewDir(dx, dy);
  return v[0] * P.c - v[1] * P.s;
}

// World (x, y, height z) -> scene px.
function pj(x, y, z) {
  if (P.rot !== 0) { const v = viewXY(x, y); x = v[0]; y = v[1]; }
  return [(x * P.c - y * P.s) * P.K + P.ox, (x * P.s + y * P.c) * P.K * P.tilt - (z || 0) * P.zk + P.oy];
}

// Scene px -> world (x, y) on the floor (z = 0): the inverse of pj.
function unproject(sx, sy) {
  const u = (sx - P.ox) / P.K, v = (sy - P.oy) / (P.K * P.tilt);
  const det = P.c * P.c + P.s * P.s;
  const vx = (u * P.c + v * P.s) / det, vy = (-u * P.s + v * P.c) / det;
  if (P.rot === 0) return [vx, vy];
  const dx = vx - P.re, dy = vy - P.rf; // the turn is orthogonal, so its inverse is its transpose
  return [P.ra * dx + P.rc * dy, P.rb * dx + P.rd * dy];
}

// Project a point given in view coordinates (already turned).
function projectView(x, y, z) {
  return [(x * P.c - y * P.s) * P.K + P.ox, (x * P.s + y * P.c) * P.K * P.tilt - (z || 0) * P.zk + P.oy];
}

// Screen direction of the view's x axis: the basis for things lying on a wall or floor plane.
function planeBasisX() {
  const v = viewDir(1, 0);
  return [(v[0] * P.c - v[1] * P.s) * P.K, (v[0] * P.s + v[1] * P.c) * P.K * P.tilt];
}

function fillPoly(pts, fill) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function flat(x0, y0, x1, y1, z, fill) {
  fillPoly([pj(x0, y0, z), pj(x1, y0, z), pj(x1, y1, z), pj(x0, y1, z)], fill);
}

// Is the +y side of things (the side decorations are drawn on) turned towards the camera at this camera turn?
function plusYVisible() {
  return P.rot === 0 || P.rot === 3 && P.s > 0;
}

// Vertical rectangle in the plane y = const (faces the viewer). Nothing is drawn when that plane faces away.
function vface(y, x0, x1, z0, z1, fill) {
  if (!plusYVisible()) return;
  fillPoly([pj(x0, y, z0), pj(x1, y, z0), pj(x1, y, z1), pj(x0, y, z1)], fill);
}

// The light stays fixed on screen, so a shadow of length d falls towards the view's (+x, +y), i.e. along the inverse turn in the world.
function shadowOffset(d) {
  switch (P.rot) {
    case 1: return [d, -d];
    case 2: return [-d, -d];
    case 3: return [-d, d];
    default: return [d, d];
  }
}
function groundShadow(x0, y0, x1, y1, h) {
  const d = Math.min(14, h * 0.45 + 2), o = shadowOffset(d);
  flat(x0 + o[0], y0 + o[1], x1 + o[0], y1 + o[1], 0, 'rgba(31,42,55,0.11)');
}

// The side face of a box that faces the viewer, as a polygon, for each of the four sides.
function sideFace(side, x0, y0, x1, y1, z0, z1) {
  switch (side) {
    case '+y': return [pj(x0, y1, z0), pj(x1, y1, z0), pj(x1, y1, z1), pj(x0, y1, z1)];
    case '-y': return [pj(x1, y0, z0), pj(x0, y0, z0), pj(x0, y0, z1), pj(x1, y0, z1)];
    case '+x': return [pj(x1, y1, z0), pj(x1, y0, z0), pj(x1, y0, z1), pj(x1, y1, z1)];
    default: return [pj(x0, y0, z0), pj(x0, y1, z0), pj(x0, y1, z1), pj(x0, y0, z1)];
  }
}
// Per camera turn: which side faces the viewer square on ("front", screen-down) and which shows as the shaded flank.
const FRONT_SIDE = ['+y', '+x', '-y', '-x'];
const FLANK_SIDE = ['+x', '-y', '-x', '+y'];

// Extruded box: lit top, front face and shaded side face (which sides those are depends on the camera turn). o.glass = translucent; o.top / o.flank = exact colours of the top and the shaded side.
function box(x0, y0, x1, y1, z0, z1, col, o) {
  o = o || {};
  if (!o.noShadow) groundShadow(x0, y0, x1, y1, z1);
  const g = !!o.glass;
  fillPoly(sideFace(FRONT_SIDE[P.rot], x0, y0, x1, y1, z0, z1), g ? 'rgba(160,215,240,0.30)' : col);
  if (P.s > 0) fillPoly(sideFace(FLANK_SIDE[P.rot], x0, y0, x1, y1, z0, z1), g ? 'rgba(120,190,225,0.38)' : (o.flank || mix(col, -0.22)));
  fillPoly([pj(x0, y0, z1), pj(x1, y0, z1), pj(x1, y1, z1), pj(x0, y1, z1)], g ? 'rgba(235,248,255,0.65)' : (o.top || mix(col, 0.16)));
  if (g) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ---------- depth sorting ----------

function behind(a, b) { return a.y1 <= b.y0 || (P.s > 0 && a.x1 <= b.x0); }
function before(a, b) {
  const ab = behind(a, b), ba = behind(b, a);
  if (ab && !ba) return true;
  if (ba && !ab) return false;
  return a.k < b.k;
}
// Offset-free projection used for screen bounding boxes (the common ox/oy offset cancels out).
function pjr(x, y, z) {
  if (P.rot !== 0) { const v = viewDir(x, y); x = v[0]; y = v[1]; }
  return [(x * P.c - y * P.s) * P.K, (x * P.s + y * P.c) * P.K * P.tilt - z * P.zk];
}
function footprintBox(x0, y0, x1, y1, h) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [x, y, z] of [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]]) {
    const q = pjr(x, y, z);
    if (q[0] < u0) u0 = q[0]; if (q[0] > u1) u1 = q[0];
    if (q[1] < v0) v0 = q[1]; if (q[1] > v1) v1 = q[1];
  }
  return [u0, v0, u1, v1];
}
const sbOverlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// Painter's order. Pairs that do not overlap on screen need no order at all; constraining them (by the
// diagonal tie-break) created cycles with far-away walls that left walls drawn on top of seated characters.
function depthSort(items) {
  const n = items.length, out = [], st = new Uint8Array(n);
  const visit = (i) => {
    if (st[i]) return;
    st[i] = 1;
    for (let j = 0; j < n; j++) if (j !== i && st[j] === 0 && sbOverlap(items[j].sb, items[i].sb) && before(items[j], items[i])) visit(j);
    out.push(items[i]);
    st[i] = 2;
  };
  for (let i = 0; i < n; i++) visit(i);
  return out;
}

function addItem(L, x0, y0, x1, y1, draw, h) {
  // sorted by the rectangle in view coordinates (the order is about what is in front of what on screen); drawn with world coordinates
  const r = viewRect(x0, y0, x1, y1);
  L.items.push({ wr: [x0, y0, x1, y1], x0: r[0], y0: r[1], x1: r[2], y1: r[3], k: P.s > 0 ? (r[0] + r[2] + r[1] + r[3]) / 2 : (r[1] + r[3]) / 2, draw, sb: footprintBox(x0, y0, x1, y1, h || 60) });
}
function addBoxItem(L, x0, y0, x1, y1, z0, z1, col, o) {
  addItem(L, x0, y0, x1, y1, () => box(x0, y0, x1, y1, z0, z1, col, o), z1);
}
