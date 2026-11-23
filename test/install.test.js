'use strict';
// Runs the installer against a throwaway home directory; the real ~/.claude, ~/.gemini and
// ~/.config/opencode are never touched.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, ROOT_PLACEHOLDER } = require('../lib/install');
const { ROOT } = require('./helpers');

const slashRoot = ROOT.replace(/\\/g, '/');
let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'alifgunadi-office-install-test-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (opts = {}) => install({ root: ROOT, home, ...opts });
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(home, ...parts), 'utf8'));
const backups = () => fs.readdirSync(home, { recursive: true }).filter((f) => String(f).includes('.bak-'));
const commandsOf = (settings, event) => (settings.hooks[event] || []).flatMap((g) => g.hooks.map((h) => h.command));

describe('install: fresh machine', () => {
  it('creates the Claude hooks, the Antigravity plugin files and the OpenCode plugin', () => {
    const report = run();
    assert.ok(report.every((r) => r.result === 'created'), JSON.stringify(report));

    const settings = readJson('.claude', 'settings.json');
    for (const event of ['SessionStart', 'PreToolUse', 'Stop', 'StopFailure', 'SessionEnd']) {
      assert.ok(commandsOf(settings, event).some((c) => c.includes(`${slashRoot}/hook.js`)), event);
    }
    assert.ok(commandsOf(settings, 'SessionStart').some((c) => c.includes(`${slashRoot}/ensure-server.js`)));

    const agy = path.join(home, '.gemini', 'config', 'plugins', 'migrated-settings');
    assert.ok(fs.readFileSync(path.join(agy, 'agy-office-hook.js'), 'utf8').includes(`'${slashRoot}'`));
    assert.ok(readJson('.gemini', 'config', 'plugins', 'migrated-settings', 'hooks.json')['alifgunadi-office'].SessionStart);
    assert.ok(fs.readFileSync(path.join(home, '.config', 'opencode', 'plugins', 'alifgunadi-office.js'), 'utf8').includes(`"${slashRoot}"`));
  });

  it('leaves no placeholder behind', () => {
    run();
    for (const file of ['.claude/settings.json', '.gemini/config/plugins/migrated-settings/agy-office-hook.js', '.config/opencode/plugins/alifgunadi-office.js']) {
      const text = fs.readFileSync(path.join(home, file), 'utf8');
      assert.ok(!text.includes(ROOT_PLACEHOLDER), file);
    }
  });
});

describe('install: idempotence and safety', () => {
  it('a second run changes nothing and creates no backups', () => {
    run();
    const second = run();
    assert.ok(second.every((r) => r.result === 'unchanged'), JSON.stringify(second));
    assert.deepEqual(backups(), []);
  });

  it('keeps unrelated settings and other hooks, and backs the file up before changing it', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:/tools/audit.js"' }] }] },
    };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(original, null, 2));
    run({ targets: ['claude'] });

    const settings = readJson('.claude', 'settings.json');
    assert.equal(settings.model, 'opus');
    assert.deepEqual(settings.permissions, original.permissions);
    assert.ok(commandsOf(settings, 'PreToolUse').includes('node "C:/tools/audit.js"'));
    assert.ok(commandsOf(settings, 'PreToolUse').some((c) => c.includes('hook.js')));
    const saved = backups();
    assert.equal(saved.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, saved[0]), 'utf8')), original);
  });

  it('moves an existing AlifGunadi Office hook to the new location instead of duplicating it', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const old = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "D:/old/alifgunadi-office/hook.js"', timeout: 5 }] }] } };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(old));
    run({ targets: ['claude'] });
    const commands = commandsOf(readJson('.claude', 'settings.json'), 'PreToolUse');
    assert.equal(commands.length, 1);
    assert.equal(commands[0], `node "${slashRoot}/hook.js"`);
  });

  it('replaces hooks installed under the old agent-office name instead of duplicating them', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const old = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "c:/projects/agent-office/hook.js"', timeout: 5 }] }] } };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(old));
    run({ targets: ['claude'] });
    assert.deepEqual(commandsOf(readJson('.claude', 'settings.json'), 'PreToolUse'), [`node "${slashRoot}/hook.js"`]);
  });

  it('retires the old Antigravity key and OpenCode plugin file from before the rename', () => {
    const agy = path.join(home, '.gemini', 'config', 'plugins', 'migrated-settings');
    const oc = path.join(home, '.config', 'opencode', 'plugins');
    fs.mkdirSync(agy, { recursive: true });
    fs.mkdirSync(oc, { recursive: true });
    fs.writeFileSync(path.join(agy, 'hooks.json'), JSON.stringify({ 'agent-office': { Stop: [] }, 'other-plugin': { Stop: [] } }));
    fs.writeFileSync(path.join(oc, 'agent-office.js'), '// old');
    run({ targets: ['antigravity', 'opencode'] });
    const hooks = readJson('.gemini', 'config', 'plugins', 'migrated-settings', 'hooks.json');
    assert.equal(hooks['agent-office'], undefined);
    assert.deepEqual(hooks['other-plugin'], { Stop: [] });
    assert.ok(!fs.existsSync(path.join(oc, 'agent-office.js')));
    assert.ok(fs.existsSync(path.join(oc, 'alifgunadi-office.js')));
  });

  it('does not touch a hook.js that belongs to another project', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/other-project/hook.js"' }] }] } };
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(other));
    run({ targets: ['claude'] });
    const commands = commandsOf(readJson('.claude', 'settings.json'), 'Stop');
    assert.ok(commands.includes('node "C:/other-project/hook.js"'));
    assert.ok(commands.includes(`node "${slashRoot}/hook.js"`));
  });

  it('refuses settings that are not plain JSON and writes nothing', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const file = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(file, '{ // comment\n "hooks": {} }');
    assert.throws(() => run({ targets: ['claude'] }), /not plain JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ // comment\n "hooks": {} }');
    assert.deepEqual(backups(), []);
  });

  it('dry run reports but writes nothing', () => {
    const report = run({ dryRun: true });
    assert.ok(report.every((r) => r.result === 'created'));
    assert.deepEqual(fs.readdirSync(home), []);
  });

  it('keeps other plugins in the Antigravity hooks.json', () => {
    const dir = path.join(home, '.gemini', 'config', 'plugins', 'migrated-settings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ 'other-plugin': { Stop: [] }, 'alifgunadi-office': { Stop: [] } }));
    run({ targets: ['antigravity'] });
    const hooks = readJson('.gemini', 'config', 'plugins', 'migrated-settings', 'hooks.json');
    assert.deepEqual(hooks['other-plugin'], { Stop: [] });
    assert.ok(hooks['alifgunadi-office'].SessionStart);
  });
});

describe('install.js command line', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'install.js'), ...args], { encoding: 'utf8' });

  it('installs into a custom home and prints one line per file', () => {
    const r = cli('--home', home, '--target', 'opencode');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /created\s+opencode/);
    assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'alifgunadi-office.js')));
  });

  it('rejects an unknown target with a non-zero exit', () => {
    const r = cli('--home', home, '--target', 'bogus');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown target/);
    assert.deepEqual(fs.readdirSync(home), []);
  });
});
