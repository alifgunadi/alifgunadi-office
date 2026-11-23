'use strict';
// Which folders a task may run in (lib/workspaces.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFolder, createWorkspaces } = require('../lib/workspaces');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ws-'));
const make = (spec, extraEnv = {}) => createWorkspaces({ env: { ...process.env, ...extraEnv, ALIFGUNADI_OFFICE_WORKSPACES: spec } });

describe('workspaces', () => {
  it('lists the folders of the environment by id and label only, never a path', () => {
    const a = tmp(), b = tmp();
    const w = make(`one=${a};two=${b}`);
    assert.deepEqual(w.list(), [{ id: 'one', label: 'one' }, { id: 'two', label: 'two' }]);
    assert.ok(!JSON.stringify(w.list()).includes(a));
    assert.equal(w.resolve('one'), fs.realpathSync.native(a));
  });

  it('is empty when nothing is configured', () => {
    const w = createWorkspaces({ env: {} });
    assert.deepEqual(w.list(), []);
    assert.equal(w.resolve('anything'), null);
  });

  it('refuses an id that is not in the list, whatever it looks like', () => {
    const w = make(`one=${tmp()}`);
    for (const id of ['two', '', '../one', 'one/..', 'ONE', undefined, null, 5, {}, ['one'], '__proto__', 'constructor']) assert.equal(w.resolve(id), null, String(id));
  });

  it('skips bad entries: odd ids, relative paths, files, missing folders, duplicates', () => {
    const dir = tmp(), file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const w = make(`Bad Id=${dir};rel=some/where;afile=${file};missing=${path.join(dir, 'nope')};ok=${dir};ok=${dir};noequals`);
    assert.deepEqual(w.list().map((x) => x.id), ['ok']);
    assert.ok(w.skipped.length >= 5);
  });

  it('refuses a drive or filesystem root and the folders of the system', () => {
    assert.equal(checkFolder(path.parse(process.cwd()).root), null);
    if (process.platform === 'win32') {
      for (const d of [process.env.SystemRoot, process.env.ProgramFiles, path.join(process.env.SystemRoot, 'System32')]) assert.equal(checkFolder(d), null, d);
    } else {
      for (const d of ['/', '/etc', '/usr/bin']) assert.equal(checkFolder(d), null, d);
    }
    assert.ok(checkFolder(tmp()));
  });

  it('checks again at use: a folder that disappears is no longer a workspace', () => {
    const dir = tmp();
    const w = make(`gone=${dir}`);
    assert.ok(w.resolve('gone'));
    fs.rmSync(dir, { recursive: true });
    assert.equal(w.resolve('gone'), null);
  });

  it('a folder swapped for a link to somewhere else is refused (the real path changed)', (t) => {
    const dir = tmp(), other = tmp();
    const w = make(`swap=${dir}`);
    fs.rmSync(dir, { recursive: true });
    try { fs.symlinkSync(other, dir, 'junction'); } catch { return t.skip('cannot create a link here'); }
    assert.equal(w.resolve('swap'), null);
  });
});
