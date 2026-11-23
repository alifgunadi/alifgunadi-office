'use strict';

// ---------- agents: state, routes, movement ----------

function syncAgents(list) {
  const now = performance.now();
  const seen = new Set();
  const roleIds = Object.keys(ROLES);
  for (const d of list) {
    seen.add(d.id);
    const status = d.status || 'idle';
    // how long the server says this desk has been in its current state (same machine, so clocks agree)
    const age = Math.max(0, Date.now() - (Number(d.updatedAt) || Date.now()));
    let a = agents.get(d.id);
    if (!a) {
      a = {
        id: d.id, status, guest: !hasOwn(ROLES, d.id), snap: true, s: 0, total: 0, prefix: 0, route: null, cum: null,
        slot: -1, ver: -1, idleAt: now, dir: 0, lastDir: 1, flip: false, chair: 0, x: 0, y: 0, hx: NaN, hy: NaN,
        seed: hashStr(d.id) % 97, loc: 'at desk', st: null, nextStroll: 0, strolls: 0, chat: null,
        stagger: Math.min(STAGGER_MAX, Math.max(0, roleIds.indexOf(d.id)) * STAGGER_STEP),
      };
      agents.set(d.id, a);
    } else if (a.status !== status) {
      a.status = status;
    }
    // idle time comes from the server's updatedAt, so a page reload does not restart the 30 minute wait
    if (status === 'idle') a.idleAt = now - age;
  }
  for (const [id, a] of agents) {
    if (!seen.has(id)) { releaseSlot(a); agents.delete(id); }
  }
}

function assignSlot(a) {
  const n = layout.lounge.slots.length;
  if (slotOwner.length !== n) slotOwner = new Array(n).fill(null);
  const start = hashStr(a.id) % n;
  let idx = start;
  for (let i = 0; i < n; i++) {
    const j = (start + i) % n;
    if (slotOwner[j] === null) { idx = j; break; }
  }
  slotOwner[idx] = a.id;
  a.slot = idx;
}

function releaseSlot(a) {
  if (a.slot >= 0 && slotOwner[a.slot] === a.id) slotOwner[a.slot] = null;
  a.slot = -1;
}

// Route desk -> own door (-> the next room's door) -> lounge hub -> slot, in world coords.
function buildRoute(a, slot) {
  const p = layout.byId.get(a.id), g = layout.lounge;
  if (!p || !g) return false;
  const k = p.k, lane = p.y + 142 * k, pts = [];
  pts.push([p.x + CX * k, p.y + 78 * k], [p.x + (CX + 86) * k, p.y + 84 * k], [p.x + (CX + 86) * k, lane]);
  if (layout.cols === 0) {
    for (const q of p.tail) pts.push(q); // out of the room by its door, then along the lounge's hub row (see buildLayout)
    pts.push([g.hub.x, g.hub.y]);
  } else {
    const gx = p.zone.x + GX_OFF;
    pts.push([gx, lane], [g.hub.x, g.hub.y]);
  }
  const hubIdx = pts.length - 1;
  if (slot) {
    if (slot.via) pts.push(slot.via);
    pts.push([slot.x, slot.y]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  a.route = pts; a.cum = cum; a.prefix = cum[hubIdx]; a.total = cum[cum.length - 1]; a.ver = layout.ver;
  return true;
}

function samplePath(pts, cum, s0) {
  const s = Math.max(0, s0);
  for (let i = 1; i < pts.length; i++) {
    if (s <= cum[i] || i === pts.length - 1) {
      const seg = cum[i] - cum[i - 1] || 1;
      const f = Math.min(1, Math.max(0, (s - cum[i - 1]) / seg));
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      return { x: pts[i - 1][0] + dx * f, y: pts[i - 1][1] + dy * f, dx, dy };
    }
  }
  return { x: pts[0][0], y: pts[0][1], dx: 0, dy: 0 };
}

const strollDelay = (a) => 10000 + (hashStr(a.id) * 31 + (a.strolls || 0) * 977) % 15000;

function cancelStroll(a) {
  if (!a.st) return;
  if (slotOwner[a.st.to] === a.id) slotOwner[a.st.to] = null;
  a.st = null;
  a.nextStroll = 0;
}

// A lounging agent walks to another free slot (reserved up front so nobody overlaps).
function startStroll(a, now) {
  const L = layout, S = L.lounge.slots, n = S.length, base = hashStr(a.id) + (a.strolls || 0) * 7;
  a.strolls = (a.strolls || 0) + 1;
  let to = -1;
  for (let i = 0; i < n; i++) {
    const j = (base + i) % n;
    if (j !== a.slot && slotOwner[j] === null) { to = j; break; }
  }
  if (to < 0) { a.nextStroll = now + strollDelay(a); return; }
  const f = S[a.slot], d = S[to], row = L.lounge.hub.y;
  const eg = (sl) => (sl.via ? [sl.via, [sl.via[0], row]] : [[sl.x, row]]);
  const pts = [[f.x, f.y], ...eg(f), ...eg(d).reverse(), [d.x, d.y]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  slotOwner[to] = a.id;
  a.st = { pts, cum, len: cum[cum.length - 1], p: 0, to };
}

function updateAgents(dt, now, big) {
  const L = layout;
  if (!L || !L.lounge) return;
  for (const a of agents.values()) {
    const p = L.byId.get(a.id);
    if (!p) continue;
    if (a.id === MAIN_ID && a.man && updateMain(a, dt, now)) continue; // under manual control (control.js)
    const idle = !a.guest && a.status === 'idle';
    if (a.snap) {
      a.snap = false;
      // first sync: only agents that have already been idle long enough start in the lounge
      if (idle && now - a.idleAt >= LEAVE_GRACE_MS) {
        assignSlot(a);
        buildRoute(a, L.lounge.slots[a.slot]);
        a.s = a.total; a.chair = 1;
        a.nextStroll = now + strollDelay(a);
      } else { a.s = 0; }
    } else if (a.route && a.ver !== L.ver) {
      cancelStroll(a);
      const f = a.total > 0 ? a.s / a.total : 0;
      buildRoute(a, a.slot >= 0 ? L.lounge.slots[a.slot] : null);
      a.s = f * a.total;
    }
    // Leave only after the grace delay; return immediately when work arrives.
    let goLounge;
    if (a.slot >= 0 || a.s > 0.5) goLounge = idle;
    else goLounge = idle && now - a.idleAt >= LEAVE_GRACE_MS + a.stagger;
    if (a.st && !goLounge) cancelStroll(a);
    if (goLounge) {
      if (a.slot < 0) { assignSlot(a); buildRoute(a, L.lounge.slots[a.slot]); }
    } else if (a.slot >= 0 && (!a.route || a.s <= a.prefix + 0.5)) {
      releaseSlot(a);
      if (a.route) buildRoute(a, null);
    }
    const tgt = goLounge && a.route ? a.total : 0;
    if (a.s !== tgt) {
      if (reduced || big || L.cols === 2) {
        a.s = tgt; a.dir = 0;
      } else {
        const dir = tgt > a.s ? 1 : -1;
        const ease = 0.4 + 0.6 * Math.min(1, Math.min(a.s, a.total - a.s) / 40);
        const v = Math.max(WALK_SPEED, a.total / MAX_TRIP_S) * ease;
        a.s += dir * v * dt;
        if ((dir > 0 && a.s > tgt) || (dir < 0 && a.s < tgt)) a.s = tgt;
        a.dir = dir; a.lastDir = dir;
      }
    } else { a.dir = 0; }
    // lounge strolls: every 10-25 s a lounging agent moves to another free slot
    const lounging = goLounge && a.slot >= 0 && a.route && a.s >= a.total - 0.5;
    if (lounging) {
      if (a.st) {
        a.st.p += STROLL_SPEED * dt;
        if (a.st.p >= a.st.len) {
          const to = a.st.to;
          if (slotOwner[a.slot] === a.id) slotOwner[a.slot] = null;
          a.slot = to; a.st = null;
          buildRoute(a, L.lounge.slots[to]);
          a.s = a.total;
          a.nextStroll = now + strollDelay(a);
        }
      } else if (!reduced && !big && L.cols !== 2) {
        if (!a.nextStroll) a.nextStroll = now + strollDelay(a);
        else if (now >= a.nextStroll) startStroll(a, now);
      }
    } else if (!a.st) { a.nextStroll = 0; }
    if (a.st) {
      const q = samplePath(a.st.pts, a.st.cum, a.st.p);
      a.x = q.x; a.y = q.y;
      const du = screenDu(q.dx, q.dy);
      if (Math.abs(du) > 0.01) a.flip = du < 0;
    } else if (a.route && a.s > 0) {
      const q = samplePath(a.route, a.cum, Math.min(a.s, a.total));
      a.x = q.x; a.y = q.y;
      const du = screenDu(q.dx, q.dy) * a.lastDir;
      if (Math.abs(du) > 0.01) a.flip = du < 0;
    } else {
      a.x = p.x + CX * p.k; a.y = p.y + 78 * p.k;
    }
    const ct = a.s > 0.5 ? 1 : 0;
    a.chair = (reduced || big) ? ct : Math.max(0, Math.min(1, a.chair + (ct - a.chair) * Math.min(1, dt * 8)));
    a.loc = a.st ? 'walking' : (a.s <= 0.5 ? 'at desk' : (a.slot >= 0 && a.s >= a.total - 0.5 ? 'in the lounge' : 'walking'));
  }
}

// Conversation groups in the lounge (slot indices), with turn taking.
const CHAT_GROUPS = [[0, 3, 7], [1, 6], [2, 4, 8, 11], [9, 12]];
const CHAT_ICONS = [['…', '💬'], ['☕', '…'], ['…', '!', '💬'], ['♪', '…']];
function computeChat(t) {
  for (const a of agents.values()) a.chat = null;
  if (reduced || !layout || !layout.lounge) return;
  CHAT_GROUPS.forEach((members, gi) => {
    const occ = [];
    for (const si of members) {
      const id = slotOwner[si];
      const a = id ? agents.get(id) : null;
      if (a && a.slot === si && !a.st && a.total > 0 && a.s >= a.total - 0.5) occ.push(a);
    }
    if (occ.length < 2) return;
    const turn = Math.floor(t / 3400 + gi * 1.7);
    const sp = occ[turn % occ.length];
    const laugh = ((t / 1000 + gi * 3.3) % 9) < 1.1;
    const dirTo = (a, b) => {
      const va = viewXY(a.x, a.y), vb = viewXY(b.x, b.y);
      const du = (vb[0] * P.c - vb[1] * P.s) - (va[0] * P.c - va[1] * P.s);
      return du > 1 ? 1 : du < -1 ? -1 : 0;
    };
    const icons = CHAT_ICONS[gi];
    for (const a of occ) {
      const speak = a === sp;
      a.chat = {
        speak, laugh,
        look: dirTo(a, speak ? occ[(turn + 1) % occ.length] : sp),
        nod: !speak && ((t / 700 + a.seed) % 5) < 0.6,
        icon: icons[turn % icons.length],
      };
    }
  });
}

function refreshAria() {
  const txt = desks.length
    ? desks.map((d) => {
      const a = agents.get(d.id);
      return roleOf(d.id).label + ': ' + (d.status || 'unknown') + (a ? ', ' + a.loc : '');
    }).join('; ')
    : 'No agents yet.';
  if (txt === ariaKey) return;
  ariaKey = txt;
  canvas.setAttribute('aria-label', 'Office floorplan. ' + txt);
}
