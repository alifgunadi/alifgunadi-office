'use strict';
// The folders a task may run in. The page only ever names a folder by its id; this module is the one place that turns an id into a
// path, and it checks the path again every time. Where the folders come from, in order of priority:
//   1. ALIFGUNADI_OFFICE_WORKSPACES=alifgunadi-office=C:\projects\alifgunadi-office;design-system=C:\projects\design-system  (a fixed list; nothing else counts)
//   2. a parent folder chosen on the page (the settings file), 3. ALIFGUNADI_OFFICE_ROOTS (its first entry), 4. the default parent folder:
//      every ordinary sub-folder of the parent folder is a workspace.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ROOT_CACHE_MS = 5000;
const MAX_SCANNED = 200;
const SKIP_NAMES = new Set(['node_modules']);

// Places that are never a workspace: a drive root, and the folders of the system.
function forbiddenRoots(env, platform) {
  if (platform === 'win32') {
    return [env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData].filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc', '/dev', '/boot', '/lib', '/root'];
}

// Returns the real path if the folder is acceptable, otherwise null.
function checkFolder(dir, { env = process.env, platform = process.platform } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || isUnc(dir)) return null;
  let real;
  try {
    real = realOf(dir);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch { return null; }
  if (path.parse(real).root === real) return null; // a drive root
  const low = platform === 'win32' ? real.toLowerCase() : real;
  const cmp = platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
  for (const bad of forbiddenRoots(env, platform)) {
    if (cmp(low) === cmp(bad) || low.startsWith(cmp(bad) + path.sep)) return null;
  }
  return real;
}

// The JS realpath keeps 8.3 short names (C:\PROGRA~1, C:\Users\USER~1); only the native one expands them, and every comparison below is
// against long names. A UNC path (\\host\share) would make this process contact another machine, so it is refused up front.
const realOf = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
const isUnc = (p) => p.startsWith("\\\\") || p.startsWith('//');
const MAX_READ = 5000; // entries looked at in one folder: a huge folder cannot hold the server up

function listDirents(dir, max = MAX_READ) {
  const d = fs.opendirSync(dir);
  const out = [];
  try {
    let e;
    while (out.length < max && (e = d.readSync())) out.push(e);
  } finally { d.closeSync(); }
  return out;
}

const sameOrInside = (parent, child, platform) => {
  const a = platform === 'win32' ? parent.toLowerCase() : parent;
  const b = platform === 'win32' ? child.toLowerCase() : child;
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

// Places that hold credentials, settings or other people's files, whatever the account: the other profiles next to the home folder
// (C:\Users\*), the well-known folders inside the home folder (AppData, Documents, Desktop, Downloads), anything inside a folder whose
// name starts with a dot (.ssh, .aws, .config), and the system folders of a drive.
const HOME_PLACES = new Set(['appdata', 'documents', 'desktop', 'downloads', 'onedrive']);
const DRIVE_PLACES = new Set(['$recycle.bin', 'system volume information']);
function tooBroadPlace(real, realHome, platform) {
  const cmp = platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
  const parts = real.slice(path.parse(real).root.length).split(path.sep).filter(Boolean).map(cmp);
  if (parts.some((p) => p.startsWith('.') || DRIVE_PLACES.has(p))) return true;
  if (realHome) {
    const profiles = path.dirname(realHome);
    if (profiles !== realHome && path.dirname(real) === profiles) return true; // another profile, or Public
    if (sameOrInside(realHome, real, platform)) {
      const first = real.slice(realHome.length).split(path.sep).filter(Boolean)[0];
      if (first && (HOME_PLACES.has(cmp(first)) || cmp(first).startsWith('onedrive'))) return true;
    }
  }
  return false;
}

// The real path of a folder that may be the parent of the workspaces, or why not. Too broad: a drive root, a system folder, or the
// user's home folder or anything above it (every project of the account would become a workspace).
function inspectRoot(dir, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (typeof dir !== 'string' || dir.length === 0 || dir.length > 1024 || dir.includes('\0') || !path.isAbsolute(dir) || isUnc(dir)) return { ok: false, error: 'not_found' };
  let real;
  try {
    real = realOf(dir);
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: 'not_found' };
  } catch { return { ok: false, error: 'not_found' }; }
  if (path.parse(real).root === real) return { ok: false, error: 'too_broad' };
  for (const bad of forbiddenRoots(env, platform)) if (sameOrInside(bad, real, platform)) return { ok: false, error: 'too_broad' };
  let realHome = null;
  try { realHome = realOf(home); } catch { /* no home folder */ }
  if (realHome && sameOrInside(real, realHome, platform)) return { ok: false, error: 'too_broad' };
  if (tooBroadPlace(real, realHome, platform)) return { ok: false, error: 'too_broad' };
  try { listDirents(real, 1); } catch { return { ok: false, error: 'not_readable' }; }
  return { ok: true, real };
}

function parseList(spec) {
  const out = [];
  for (const part of String(spec || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40).replace(/[-._]+$/, '');

function createWorkspaces(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fixed = new Map();
  const skipped = [];
  for (const [id, dir] of parseList(env.ALIFGUNADI_OFFICE_WORKSPACES)) {
    if (!ID_RE.test(id)) { skipped.push(id + ': not a valid id'); continue; }
    if (fixed.has(id)) { skipped.push(id + ': listed twice'); continue; }
    const real = checkFolder(dir, options);
    if (!real) { skipped.push(id + ': not an acceptable folder'); continue; }
    fixed.set(id, real);
  }
  // Set at all (even when every entry was skipped): the fixed list wins, and the page cannot choose another folder.
  const locked = String(env.ALIFGUNADI_OFFICE_WORKSPACES || '').trim() !== '';
  const inspectOptions = { env, platform, home: options.home || env.ALIFGUNADI_OFFICE_HOME || undefined }; // ALIFGUNADI_OFFICE_HOME: for tests and unusual layouts
  const cacheMs = options.cacheMs === undefined ? ROOT_CACHE_MS : options.cacheMs;

  // The parent folder in force, with where it came from.
  function chosenRoot() {
    const st = options.settings ? options.settings.state() : { root: null, error: null };
    if (st.error) return { source: 'ui', dir: null, error: st.error }; // an unreadable settings file means no folders, not a wider default
    if (st.root) return { source: 'ui', dir: st.root };
    const fromEnv = String(env.ALIFGUNADI_OFFICE_ROOTS || '').split(';').map((p) => p.trim()).find(Boolean);
    if (fromEnv) return { source: 'env', dir: fromEnv };
    if (options.defaultRoot) return { source: 'default', dir: options.defaultRoot };
    return { source: 'none', dir: null };
  }

  // Folders that are never workspaces even when they sit inside the parent folder (the checkout of this program: editing hook.js there
  // would run code in every Claude Code session).
  const excludes = (options.exclude || []).map((p) => { try { return realOf(p); } catch { return path.resolve(p); } });
  const excluded = (p) => excludes.some((x) => sameOrInside(x, p, platform));

  let cache = null; // the last scan, kept for a few seconds so a dropdown does not read the disk each time it opens
  function scan(now = Date.now()) {
    const pick = chosenRoot();
    const key = pick.source + '|' + pick.dir + '|' + (pick.error || '');
    if (cache && cache.key === key && now - cache.at < cacheMs) return cache;
    const out = { at: now, key, source: pick.source, dir: pick.dir, root: null, error: pick.error || null, entries: new Map() };
    if (pick.dir) {
      const r = inspectRoot(pick.dir, inspectOptions);
      if (!r.ok) out.error = r.error;
      else {
        out.root = r.real;
        let items = [];
        try { items = listDirents(r.real); } catch { out.error = 'not_readable'; }
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of items) {
          if (out.entries.size >= MAX_SCANNED) break;
          if (!d.isDirectory() || d.name.startsWith('.') || SKIP_NAMES.has(d.name.toLowerCase())) continue; // a link is not a directory here
          if (excluded(path.join(r.real, d.name))) continue;
          const id = slug(d.name);
          if (!ID_RE.test(id) || out.entries.has(id)) continue;
          out.entries.set(id, { name: d.name, label: d.name });
        }
      }
    }
    cache = out;
    return out;
  }

  function resolveScanned(id) {
    const sc = scan();
    const e = sc.root && sc.entries.get(id);
    if (!e) return null;
    const real = checkFolder(path.join(sc.root, e.name), options);
    // a folder swapped for a link that leads out of the parent folder is refused
    return real && real !== sc.root && sameOrInside(sc.root, real, platform) && !excluded(real) ? real : null;
  }

  return {
    skipped,
    locked,
    // ids and labels only: the page never sees a path
    list: () => (locked ? [...fixed.keys()].map((id) => ({ id, label: id })) : [...scan().entries].map(([id, e]) => ({ id, label: e.label }))),
    // the folder for an id, checked again now (it may have been removed or swapped for a link since the server started)
    resolve(id) {
      if (typeof id !== 'string') return null;
      if (locked) {
        if (!fixed.has(id)) return null;
        const real = checkFolder(fixed.get(id), options);
        return real && real === fixed.get(id) ? real : null;
      }
      return resolveScanned(id);
    },
    // What the settings dialog shows. This is the only place a path leaves this module, and only to a logged-in user.
    info() {
      if (locked) return { source: 'fixed', locked: true, root: null, error: null, count: fixed.size };
      const sc = scan();
      return { source: sc.source, locked: false, root: sc.dir, error: sc.error, count: sc.entries.size };
    },
    // Choose the parent folder (null: back to the default). Returns { ok } or { ok: false, error }.
    setRoot(dir) {
      if (locked) return { ok: false, error: 'locked_by_env' };
      if (!options.settings) return { ok: false, error: 'not_saved' };
      if (dir !== null) {
        const r = inspectRoot(dir, inspectOptions);
        if (!r.ok) return r;
        dir = r.real;
      }
      try { options.settings.setRoot(dir); } catch { return { ok: false, error: 'not_saved' }; }
      cache = null;
      return { ok: true };
    },
    // How a candidate folder would turn out, without saving it (the dialog checks while the user types)
    check(dir) {
      if (locked) return { ok: false, error: 'locked_by_env' };
      const r = inspectRoot(dir, inspectOptions);
      if (!r.ok) return r;
      let count = 0;
      try { count = listDirents(r.real).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_NAMES.has(d.name.toLowerCase())).length; } catch { /* counted as 0 */ }
      return { ok: true, count: Math.min(count, MAX_SCANNED) };
    },
  };
}

module.exports = { ID_RE, checkFolder, inspectRoot, createWorkspaces };
