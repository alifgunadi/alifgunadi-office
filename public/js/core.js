'use strict';

const TAU = Math.PI * 2;
const CW = 180, CH = 160, HDR = 36, TK = 1.1; // desk tile size, zone header strip, trainer desk scale
const CX = CW / 2;                   // desk centre inside its tile
const GAP = 28;                      // corridor width between rooms (wide layout)
const CORRIDOR = '#efe9da';
const T_WALL = 8, T_GLASS = 5;          // wall thickness
const WH = 22, WL = 8, WF = 6, WG = 24; // wall heights: tall, lowered back wall, front curb, glass
const WX = 52;                           // wide floor plan: the two outer back walls (with windows)
const PLAN_W = 1500, PLAN_H = 1000;      // wide floor plan: the whole floor, s:t = 3:2
const SEAT = 12;                         // seat height of chairs and sofa cushions
const GX_OFF = 24;                       // stacked layouts: walking gutter offset inside each zone
const WALK_SPEED = 140, MAX_TRIP_S = 3.5, STRIDE = 0.09;
const IDLE_TO_LOUNGE_MIN = 10;           // minutes an agent must stay idle before it leaves its desk for the lounge
const LEAVE_GRACE_MS = IDLE_TO_LOUNGE_MIN * 60 * 1000, STAGGER_STEP = 150, STAGGER_MAX = 1500;
// The isometric floor plan is used at every width: it is scaled down to fit the stage (a phone shows the whole floor, never below MIN_FIT).
// The stacked layouts (buildLayout with cols > 0) are no longer chosen by the page; they are kept for the tests of the geometry.
const MIN_FIT = 0.12;
const MAX_CANVAS_PIXELS = 16e6;          // backing store limit: at 130% zoom and a high-dpi screen the canvas would otherwise be huge
const TOP_PAD = 56;                      // css px above the floor for bubbles
const LBL = 46;                          // floor strip at the front of each room reserved for the room name
const FLOOR_UPRIGHT = 0.5;               // 0 = floor lettering fully on the floor plane, 1 = no shear (more legible)
const STROLL_SPEED = 85;                 // lounge strolls (world units per second)
const FONT_E = ", 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'";

const canvas = document.getElementById('office');
const stage = document.querySelector('.stage');
const ctx = canvas.getContext('2d');
let desks = [];
let deskMap = new Map();
let idSig = '';
let layout = null, layoutDirty = true, layoutVer = 0, availW = null, shadowK = 1, dpr = 1, sc = 1;
let animT = 0, lastT = 0, ariaKey = '', availH = 0, mouse = null, focusId = null;
// The page is split into several scripts that load one after the other. Anything asynchronous (a resize,
// a font, a media-query change) may fire between two of them, so drawing waits until net.js, the last
// script, has run and set `booted`.
let booted = false;
const agents = new Map(); // desk id -> animation state
let slotOwner = [];
// Projection: wide layout is isometric (2:1), stacked layouts use a tilted oblique view.
// rot is the camera turn in quarter turns (0-3) around the middle of the floor; ra..rf is that turn as an affine map
// (x', y') = (ra*x + rb*y + re, rc*x + rd*y + rf), see setView() in projection.js.
const P = { c: 1, s: 1, K: 0.75, tilt: 0.5, zk: 0.85, cs: 1, ox: 0, oy: 0, rot: 0, ra: 1, rb: 0, rc: 0, rd: 1, re: 0, rf: 0 };
// What the user picked with the camera controls. rot only applies to the wide layout (see setProj).
const camera = { rot: 0, zoom: 1, walls: 'cut' };

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function roleOf(id) {
  id = String(id ?? '');
  if (hasOwn(ROLES, id)) return ROLES[id];
  // Plugin agents are named "plugin:agent"; show the agent part.
  const name = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id;
  const chars = Array.from(name);
  const h = hashStr(id), f = h % 2 === 1;
  const hs = (f ? ['long', 'bob', 'pony', 'wavy', 'bun'] : ['side', 'quiff', 'undercut', 'wave'])[(h >> 1) % (f ? 5 : 4)];
  return { ...GUEST, label: chars.length > 18 ? chars.slice(0, 17).join('') + '.' : name, g: f ? 'f' : 'm', hs, outfit: f ? 'blouse' : 'polo' };
}

function hashStr(s) {
  s = String(s);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Reduced motion: teleport between desk and lounge and freeze the canvas animation.
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
// The page can also ask for less motion itself (the menu), on top of the system setting; the choice is remembered on this device.
const MOTION_KEY = 'agent-office.reduce-motion';
let userReduce = false;
try { userReduce = localStorage.getItem(MOTION_KEY) === '1'; } catch { /* storage blocked */ }
if (userReduce) document.documentElement.classList.add('reduce-motion');
let reduced = !!(motionQuery && motionQuery.matches) || userReduce;
function setUserReduce(on) {
  userReduce = on;
  try { localStorage.setItem(MOTION_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
  document.documentElement.classList.toggle('reduce-motion', on);
  reduced = !!(motionQuery && motionQuery.matches) || on;
  if (booted) renderNow();
}
if (motionQuery) {
  const onMotion = (e) => { reduced = e.matches || userReduce; if (booted) renderNow(); };
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotion);
  else if (motionQuery.addListener) motionQuery.addListener(onMotion);
}

const FONT = "'Nunito', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MAX_BUBBLE_CHARS = 32;
const BUBBLE_MAX = 156; // bubble width cap
