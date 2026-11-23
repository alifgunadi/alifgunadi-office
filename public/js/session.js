'use strict';

// ---------- login and "real mode" ----------
// The page starts as a viewer (and the simulation of the dock). When the server knows this browser (a session cookie made by opening the
// office through the launcher, which hands over a one-time-readable token in the address fragment) and has a runner switched on, the page
// switches to real mode: prompts are sent to the server, and the tasks come from the server. The token is only ever in the fragment:
// it is read once, removed from the address bar at once and posted to /auth; the page keeps nothing of it.

const session = { authed: false, real: false, runners: [], workspaces: [], maxConcurrent: 3 };
const realMode = () => session.authed && session.real;

// A small fetch that never throws: { status, data } (status 0 = the server could not be reached).
async function api(method, url, body) {
  try {
    const res = await fetch(url, { method, headers: { 'X-AlifGunadi-Office': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { /* an empty or non-JSON answer */ }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

// The tasks the server reports replace the local ones (only while in real mode).
function applyServerTasks(list) {
  if (!realMode() || !Array.isArray(list)) return false;
  const before = new Map(taskStore.tasks.map((t) => [t.id, t.status]));
  taskStore.tasks = list.map((t) => ({ ...t, folder: t.workspaceId, runMs: 0, asked: false }));
  if (typeof refreshOpenOutputs === 'function') refreshOpenOutputs(before);
  return true;
}

function enterRealMode() {
  taskStore.tasks = []; // the simulated tasks of this page are not real work
  if (typeof onRealMode === 'function') onRealMode();
  if (serverState && applyServerTasks(serverState.tasks)) tasksChanged();
}

async function initSession() {
  let loggedIn = false;
  const m = /^#token=([0-9a-f]{64})$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search); // gone from the address bar before anything else happens
    const r = await api('POST', '/auth', { token: m[1] });
    loggedIn = r.status === 200;
    if (!loggedIn) showNotice(r.status === 429 ? 'Terlalu banyak percobaan masuk. Tunggu semenit lalu buka lagi lewat peluncur.' : 'Token tidak cocok. Buka kantor lewat start-office.ps1 atau aplikasi desktop.');
  }
  const s = await api('GET', '/session');
  if (s.status === 200 && s.data && s.data.authed) {
    Object.assign(session, { authed: true, real: !!s.data.real, runners: s.data.runners || [], workspaces: s.data.workspaces || [], maxConcurrent: s.data.maxConcurrent || 3 });
    if (realMode()) enterRealMode();
  }
  if (loggedIn) reconnectStream(); // the stream that was open before the login carries no tasks
}

// The server stopped accepting the session (cookie removed, token file replaced): back to the viewer and the simulation.
function leaveRealMode() {
  if (!session.authed) return;
  session.authed = false;
  session.real = false;
  taskStore.tasks = [];
  if (typeof onRealMode === 'function') onRealMode();
  tasksChanged();
}
