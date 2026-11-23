'use strict';
// The few settings the page may change, kept in one small JSON file in the user's profile (never in the repository).
// Today that is only the parent folder whose sub-folders are the workspaces. A damaged or missing file means the defaults.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function settingsPath(env = process.env) {
  if (env.ALIFGUNADI_OFFICE_SETTINGS_FILE) return env.ALIFGUNADI_OFFICE_SETTINGS_FILE;
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'AlifGunadiOffice', 'settings.json');
}

function createSettings(file = settingsPath()) {
  // A missing file is the normal first run. A file that is there but cannot be read or understood is an error the caller must see:
  // quietly using the defaults would widen what the page can start agents in.
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return err.code === 'ENOENT' ? { data: {}, error: null } : { data: {}, error: 'settings_unreadable' }; }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data) && (data.root === undefined || typeof data.root === 'string')) return { data, error: null };
    } catch { /* falls through */ }
    return { data: {}, error: 'settings_unreadable' };
  }
  return {
    file,
    state: () => { const r = read(); return { root: typeof r.data.root === 'string' && r.data.root ? r.data.root : null, error: r.error }; },
    root: () => { const r = read(); return typeof r.data.root === 'string' && r.data.root ? r.data.root : null; },
    // null puts the default back. The write is atomic (a temporary file, then a rename), so a crash leaves the old file or the new one.
    setRoot(value) {
      const data = read().data; // a damaged file is replaced by the new choice
      if (value) data.root = value; else delete data.root;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      try { fs.renameSync(tmp, file); } catch (err) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw err; }
    },
  };
}

module.exports = { settingsPath, createSettings };
