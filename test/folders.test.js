'use strict';
// The parent folder of the workspaces: settings file, scan, priorities and the checks on a chosen folder (lib/settings.js, lib/workspaces.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings } = require('../lib/settings');
const { createWorkspaces, inspectRoot, checkFolder } = require('../lib/workspaces');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fold-'));
const mk = (root, ...names) => names.forEach((n) => fs.mkdirSync(path.join(root, n), { recursive: true }));
const settingsIn = (dir) => createSettings(path.join(dir, 'settings.json'));
const NO_HOME = path.join(os.tmpdir(), 'ao-no-such-home'); // the temp folder is usually inside the real home (AppData), which is not a place to scan
const make = (opts = {}) => createWorkspaces({ env: {}, cacheMs: 0, home: NO_HOME, ...opts });

describe('settings file', () => {
  it('is empty at first, saves the folder and puts the default back with null', () => {
    const s = settingsIn(tmp());
    assert.equal(s.root(), null);
    s.setRoot('C:\\work');
    assert.equal(s.root(), 'C:\\work');
    s.setRoot(null);
    assert.equal(s.root(), null);
  });

  it('a damaged or odd file means the defaults, not a crash', () => {
    const dir = tmp();
    const file = path.join(dir, 'settings.json');
    for (const text of ['{not json', '[]', '"x"', '{"root":5}', '']) {
      fs.writeFileSync(file, text);
      assert.equal(createSettings(file).root(), null, text);
    }
  });

  it('writes atomically: no temporary file is left and other keys survive', () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'settings.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ other: 1 }));
    const s = createSettings(file);
    s.setRoot('D:\\x');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { other: 1, root: 'D:\\x' });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
  });
});

describe('scan of the parent folder', () => {
  it('every ordinary sub-folder is a workspace: no files, hidden folders, node_modules or .git', () => {
    const root = tmp();
    mk(root, 'beta', 'alpha', '.git', '.hidden', 'node_modules', 'My Project');
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    const w = make({ defaultRoot: root });
    assert.deepEqual(w.list(), [{ id: 'alpha', label: 'alpha' }, { id: 'beta', label: 'beta' }, { id: 'my-project', label: 'My Project' }]);
    assert.equal(w.resolve('my-project'), fs.realpathSync.native(path.join(root, 'My Project')));
  });

  it('never gives the page a path, and an id that is not listed resolves to nothing', () => {
    const root = tmp();
    mk(root, 'a');
    const w = make({ defaultRoot: root });
    assert.ok(!JSON.stringify(w.list()).includes(root));
    for (const id of ['b', '', '../a', 'a/..', 'A', undefined, null, 5, {}, ['a'], '__proto__', '.git']) assert.equal(w.resolve(id), null, String(id));
  });

  it('a new project appears without a restart (after the short cache)', () => {
    const root = tmp();
    mk(root, 'one');
    const w = make({ defaultRoot: root });
    assert.equal(w.list().length, 1);
    mk(root, 'two');
    assert.deepEqual(w.list().map((x) => x.id), ['one', 'two']);
  });

  it('keeps the list for a few seconds so the disk is not read at every open', () => {
    const root = tmp();
    mk(root, 'one');
    const w = createWorkspaces({ env: {}, home: NO_HOME, defaultRoot: root });
    assert.equal(w.list().length, 1);
    mk(root, 'two');
    assert.equal(w.list().length, 1);
  });

  it('a folder removed after the scan is no longer a workspace', () => {
    const root = tmp();
    mk(root, 'one');
    const w = createWorkspaces({ env: {}, home: NO_HOME, defaultRoot: root });
    assert.ok(w.resolve('one'));
    fs.rmSync(path.join(root, 'one'), { recursive: true });
    assert.equal(w.resolve('one'), null);
  });

  it('stops at 200 folders', () => {
    const root = tmp();
    for (let i = 0; i < 230; i++) mk(root, 'p' + String(i).padStart(3, '0'));
    assert.equal(make({ defaultRoot: root }).list().length, 200);
  });

  it('a link that leads out of the parent folder is neither listed nor run', (t) => {
    const root = tmp(), other = tmp();
    mk(root, 'real');
    try { fs.symlinkSync(other, path.join(root, 'escape'), 'junction'); } catch { return t.skip('cannot create a link here'); }
    const w = make({ defaultRoot: root });
    assert.deepEqual(w.list().map((x) => x.id), ['real']);
    assert.equal(w.resolve('escape'), null);
  });

  it('a folder swapped for a link after the scan is refused', (t) => {
    const root = tmp(), other = tmp();
    mk(root, 'proj');
    const w = createWorkspaces({ env: {}, home: NO_HOME, defaultRoot: root });
    assert.ok(w.resolve('proj'));
    fs.rmSync(path.join(root, 'proj'), { recursive: true });
    try { fs.symlinkSync(other, path.join(root, 'proj'), 'junction'); } catch { return t.skip('cannot create a link here'); }
    assert.equal(w.resolve('proj'), null);
  });
});

describe('which parent folder is in force', () => {
  it('the choice on the page beats ALIFGUNADI_OFFICE_ROOTS, which beats the default', () => {
    const dir = tmp(), ui = tmp(), env = tmp(), def = tmp();
    mk(ui, 'from-ui'); mk(env, 'from-env'); mk(def, 'from-default');
    const settings = settingsIn(dir);
    const w = createWorkspaces({ env: { ALIFGUNADI_OFFICE_ROOTS: env }, home: NO_HOME, settings, defaultRoot: def, cacheMs: 0 });
    assert.equal(w.info().source, 'env');
    assert.deepEqual(w.list().map((x) => x.id), ['from-env']);
    assert.deepEqual(w.setRoot(ui), { ok: true });
    assert.equal(w.info().source, 'ui');
    assert.deepEqual(w.list().map((x) => x.id), ['from-ui']);
    assert.deepEqual(w.setRoot(null), { ok: true });
    assert.equal(w.info().source, 'env');
    assert.equal(createWorkspaces({ env: {}, home: NO_HOME, settings, defaultRoot: def, cacheMs: 0 }).info().source, 'default');
  });

  it('only the first entry of ALIFGUNADI_OFFICE_ROOTS counts', () => {
    const a = tmp(), b = tmp();
    mk(a, 'in-a'); mk(b, 'in-b');
    assert.deepEqual(make({ env: { ALIFGUNADI_OFFICE_ROOTS: ` ;${a};${b}` } }).list().map((x) => x.id), ['in-a']);
  });

  it('the fixed list wins over everything and cannot be changed from the page', () => {
    const fixedDir = tmp(), root = tmp();
    mk(root, 'scanned');
    const settings = settingsIn(tmp());
    const w = createWorkspaces({ env: { ALIFGUNADI_OFFICE_WORKSPACES: `fx=${fixedDir}` }, settings, defaultRoot: root });
    assert.deepEqual(w.list(), [{ id: 'fx', label: 'fx' }]);
    assert.equal(w.resolve('scanned'), null);
    assert.equal(w.info().locked, true);
    assert.deepEqual(w.setRoot(root), { ok: false, error: 'locked_by_env' });
    assert.deepEqual(w.check(root), { ok: false, error: 'locked_by_env' });
    assert.equal(settings.root(), null);
  });

  it('the fixed list stays in force even if every entry was skipped (the page cannot sneak a folder in)', () => {
    const w = createWorkspaces({ env: { ALIFGUNADI_OFFICE_WORKSPACES: 'x=relative' }, settings: settingsIn(tmp()), defaultRoot: tmp() });
    assert.deepEqual(w.list(), []);
    assert.equal(w.info().locked, true);
  });

  it('a saved folder that has gone is reported, and gives no workspaces instead of falling back', () => {
    const dir = tmp(), root = tmp();
    mk(root, 'p');
    const settings = settingsIn(dir);
    const w = createWorkspaces({ env: {}, home: NO_HOME, settings, defaultRoot: tmp(), cacheMs: 0 });
    assert.deepEqual(w.setRoot(root), { ok: true });
    fs.rmSync(root, { recursive: true });
    assert.deepEqual(w.list(), []);
    assert.equal(w.info().error, 'not_found');
    assert.equal(w.info().source, 'ui');
  });

  it('a damaged settings file means no folders at all, not a wider default, until a folder is chosen again', () => {
    const dir = tmp(), def = tmp(), good = tmp();
    mk(def, 'd'); mk(good, 'g');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{oops');
    const w = createWorkspaces({ env: { ALIFGUNADI_OFFICE_ROOTS: def }, home: NO_HOME, settings: settingsIn(dir), defaultRoot: def, cacheMs: 0 });
    assert.deepEqual(w.list(), []);
    assert.equal(w.info().error, 'settings_unreadable');
    assert.equal(w.resolve('d'), null);
    for (const text of ['[]', '"x"', '{"root":5}']) {
      fs.writeFileSync(path.join(dir, 'settings.json'), text);
      assert.equal(w.info().error, 'settings_unreadable', text);
    }
    assert.deepEqual(w.setRoot(good), { ok: true }); // the new choice replaces the bad file
    assert.deepEqual(w.list().map((x) => x.id), ['g']);
    assert.equal(w.info().error, null);
  });

  it('a missing settings file is not an error', () => {
    const w = createWorkspaces({ env: {}, home: NO_HOME, settings: settingsIn(tmp()), cacheMs: 0 });
    assert.equal(w.info().error, null);
    assert.equal(w.info().source, 'none');
  });

  it('a folder that is excluded (the checkout of this program) is never a workspace, even inside the parent folder', () => {
    const root = tmp();
    mk(root, 'mine', 'app', path.join('app', 'inner'));
    const w = createWorkspaces({ env: { ALIFGUNADI_OFFICE_ROOTS: root }, home: NO_HOME, exclude: [path.join(root, 'app')], cacheMs: 0 });
    assert.deepEqual(w.list().map((x) => x.id), ['mine']);
    assert.equal(w.resolve('app'), null);
  });

});

describe('choosing a parent folder', () => {
  const win = process.platform === 'win32';

  it('accepts a real folder and canonicalises it', () => {
    const root = tmp();
    mk(root, 'a', 'b');
    const w = make({ settings: settingsIn(tmp()) });
    assert.deepEqual(w.check(root), { ok: true, count: 2 });
    assert.deepEqual(w.setRoot(root), { ok: true });
    assert.equal(w.info().root, fs.realpathSync.native(root));
  });

  it('refuses a missing folder, a file, a relative path, odd values', () => {
    const root = tmp(), file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    const w = make({ settings: settingsIn(tmp()) });
    for (const p of [path.join(root, 'nope'), file, 'relative/dir', '', '..', '\0', 'x'.repeat(2000), '%2e%2e', path.join(root, '..', '..', 'nonexistent-zzz')]) {
      assert.deepEqual(w.setRoot(p), { ok: false, error: 'not_found' }, JSON.stringify(p).slice(0, 40));
    }
    assert.equal(w.info().source, 'none');
  });

  it('refuses a drive root, a system folder, the home folder and anything above it as too broad', () => {
    const w = make({ env: process.env, home: os.homedir(), settings: settingsIn(tmp()) });
    const cases = [path.parse(os.tmpdir()).root, os.homedir(), path.dirname(os.homedir())];
    if (win && process.env.SystemRoot) cases.push(process.env.SystemRoot, path.join(process.env.SystemRoot, 'System32'));
    if (!win) cases.push('/etc', '/usr');
    for (const p of cases) assert.deepEqual(w.setRoot(p), { ok: false, error: 'too_broad' }, p);
  });

  // a made-up user folder: <base>/Users/me with the places an account keeps its credentials and settings
  const fakeHome = () => {
    const base = tmp();
    const home = path.join(base, 'Users', 'me');
    for (const n of ['AppData', path.join('AppData', 'Local'), 'Documents', 'Desktop', 'Downloads', '.ssh', 'work', path.join('work', 'a'), path.join('Users2', 'x')]) fs.mkdirSync(path.join(home, n), { recursive: true });
    fs.mkdirSync(path.join(base, 'Users', 'other'), { recursive: true });
    fs.mkdirSync(path.join(base, 'Users', 'Public'), { recursive: true });
    return { base, home };
  };

  it('the well-known folders of the account, other profiles and dot-folders are too broad; an ordinary project folder in the home is fine', () => {
    const { base, home } = fakeHome();
    const w = make({ home, settings: settingsIn(tmp()) });
    for (const p of [home, path.dirname(home), path.join(home, 'AppData'), path.join(home, 'AppData', 'Local'), path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, '.ssh'), path.join(base, 'Users', 'other'), path.join(base, 'Users', 'Public')]) {
      assert.deepEqual(w.setRoot(p), { ok: false, error: 'too_broad' }, p);
    }
    assert.deepEqual(w.check(path.join(home, 'work')), { ok: true, count: 1 });
  });

  // the 8.3 short spelling of an existing folder, or null when the volume makes none
  const shortOf = (p) => {
    try {
      const out = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:AO_P).ShortPath'], { encoding: 'utf8', env: { ...process.env, AO_P: p } }).trim();
      return out.includes('~') ? out : null;
    } catch { return null; }
  };

  it('a short 8.3 name does not get round the checks', (t) => {
    if (!win) return t.skip('windows only');
    const probe = path.join(os.tmpdir(), 'ao-longname-folder-for-8dot3');
    fs.mkdirSync(path.join(probe, 'child'), { recursive: true });
    const short = shortOf(probe);
    if (!short) return t.skip('this volume makes no short names');
    // the short spelling resolves to the real (long) folder, and that is what is checked and used
    assert.equal(inspectRoot(short, { home: NO_HOME }).real, fs.realpathSync.native(probe));
    assert.equal(checkFolder(path.join(short, 'child')), fs.realpathSync.native(path.join(probe, 'child')));
    // the short name of the real home folder and of Program Files are caught like their long names
    const realHome = os.homedir();
    const shortHome = shortOf(realHome);
    if (shortHome) assert.deepEqual(inspectRoot(shortHome, { env: process.env, home: realHome }), { ok: false, error: 'too_broad' });
    const shortPf = process.env.ProgramFiles && shortOf(process.env.ProgramFiles);
    if (shortPf) assert.deepEqual(inspectRoot(shortPf, { env: process.env, home: realHome }), { ok: false, error: 'too_broad' });
    assert.equal(checkFolder(shortPf ? path.join(shortPf, 'Common Files') : probe) === null, Boolean(shortPf), 'a child of Program Files by its short name is refused');
  });

  it('a UNC or device path is refused before the disk is touched', () => {
    const w = make({ env: process.env, settings: settingsIn(tmp()) });
    for (const p of ['\\\\host\\share\\folder', '//host/share/folder', '\\\\?\\C:\\Windows', '\\\\.\\C:\\']) {
      assert.deepEqual(w.setRoot(p), { ok: false, error: 'not_found' }, p);
      assert.deepEqual(w.check(p), { ok: false, error: 'not_found' }, p);
    }
    assert.equal(checkFolder('\\\\host\\share\\x'), null);
  });

  it('a folder with a huge number of entries is read only up to a limit', () => {
    const root = tmp();
    for (let i = 0; i < 30; i++) mk(root, 'p' + i);
    assert.equal(make({ defaultRoot: root }).check(root).count, 30);
  });

  it('a folder inside the home folder is fine, and so is the .. spelling of the same place', () => {
    const root = tmp(); // under the temp folder
    mk(root, 'x');
    const odd = path.join(root, 'x', '..');
    assert.equal(inspectRoot(odd, { home: NO_HOME }).ok, true);
    assert.equal(inspectRoot(odd, { home: NO_HOME }).real, fs.realpathSync.native(root));
  });

  it('a link into a system folder is judged by where it leads', (t) => {
    if (!win || !process.env.SystemRoot) return t.skip('windows only');
    const root = tmp();
    const link = path.join(root, 'sys');
    try { fs.symlinkSync(process.env.SystemRoot, link, 'junction'); } catch { return t.skip('cannot create a link here'); }
    assert.deepEqual(make({ env: process.env, settings: settingsIn(tmp()) }).setRoot(link), { ok: false, error: 'too_broad' });
  });

  it('a refused choice changes nothing', () => {
    const settings = settingsIn(tmp());
    const w = make({ settings });
    w.setRoot(path.join(tmp(), 'nope'));
    assert.equal(settings.root(), null);
  });

  it('reports a settings file that cannot be written without changing the folder in force', () => {
    const root = tmp();
    const blocker = path.join(tmp(), 'blocker');
    fs.writeFileSync(blocker, 'x'); // a file where the settings folder should be
    const w = make({ settings: createSettings(path.join(blocker, 'settings.json')) });
    assert.deepEqual(w.setRoot(root), { ok: false, error: 'not_saved' });
  });
});
