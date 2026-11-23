'use strict';
// Installer logic for `node install.js`: wires the repo into Claude Code (settings.json hooks),
// Antigravity (plugin hooks.json + adapter script) and OpenCode (plugin file).
// Idempotent: running it twice changes nothing the second time. Existing files are backed up
// before they are modified, and --dry-run reports what would change without writing anything.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_PLACEHOLDER = '__ALIFGUNADI_OFFICE_ROOT__';
const TARGETS = ['claude', 'antigravity', 'opencode'];
// A hook command that belongs to AlifGunadi Office: the script sits in a folder named alifgunadi-office,
// or in the root being installed.
const SCRIPT_RE = /(hook|ensure-server)\.js/i;

const toSlashes = (p) => p.replace(/\\/g, '/');
const applyRoot = (text, root) => text.split(ROOT_PLACEHOLDER).join(toSlashes(root));
const scriptKey = (command) => (typeof command === 'string' && command.match(SCRIPT_RE)?.[1].toLowerCase()) || null;

function isOurs(command, root) {
  if (typeof command !== 'string' || !scriptKey(command)) return false;
  const normalized = toSlashes(command).toLowerCase();
  // `agent-office` is the folder name before the rename: those hooks are replaced, not duplicated.
  return /(alifgunadi|agent)-office\/(hook|ensure-server)\.js/.test(normalized) || normalized.includes(`${toSlashes(root).toLowerCase()}/`);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false, data: null, indent: 2 };
  const text = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${file} is not plain JSON (${err.message}). Fix it or edit it by hand; nothing was written.`);
  }
  return { exists: true, data, indent: /\n\t/.test(text) ? '\t' : 2 };
}

// Adds or updates the AlifGunadi Office command hooks in a Claude Code settings object.
function mergeClaudeHooks(settings, template, root) {
  let changed = false;
  settings.hooks ??= {};
  for (const [event, groups] of Object.entries(template.hooks || {})) {
    const target = (settings.hooks[event] ??= []);
    for (const templateGroup of groups) {
      for (const wanted of templateGroup.hooks || []) {
        const key = scriptKey(wanted.command);
        let found = null;
        for (const group of target) {
          for (const handler of group.hooks || []) {
            if (handler && handler.type === 'command' && scriptKey(handler.command) === key && isOurs(handler.command, root)) found = handler;
          }
        }
        if (found) {
          if (found.command !== wanted.command) {
            found.command = wanted.command;
            changed = true;
          }
        } else {
          target.push({ hooks: [{ ...wanted }] });
          changed = true;
        }
      }
    }
  }
  return changed;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Writes `content` to `file` when it differs. Returns 'created' | 'updated' | 'unchanged'.
function writeIfChanged(file, content, { dryRun }) {
  const exists = fs.existsSync(file);
  if (exists && fs.readFileSync(file, 'utf8') === content) return 'unchanged';
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (exists) fs.copyFileSync(file, `${file}.bak-${stamp()}`);
    fs.writeFileSync(file, content, 'utf8');
  }
  return exists ? 'updated' : 'created';
}

const jsonText = (data, indent) => `${JSON.stringify(data, null, indent)}\n`;

function installClaude({ root, settingsPath, dryRun }) {
  const template = JSON.parse(applyRoot(fs.readFileSync(path.join(root, 'hooks-settings-snippet.json'), 'utf8'), root));
  const current = readJsonFile(settingsPath);
  const settings = current.data || {};
  const changed = mergeClaudeHooks(settings, template, root);
  const result = changed || !current.exists ? writeIfChanged(settingsPath, jsonText(settings, current.indent), { dryRun }) : 'unchanged';
  return { target: 'claude', file: settingsPath, result };
}

function installAntigravity({ root, pluginDir, dryRun }) {
  const src = path.join(root, 'adapters', 'antigravity');
  const results = [];
  const script = applyRoot(fs.readFileSync(path.join(src, 'agy-office-hook.js'), 'utf8'), root);
  results.push({ target: 'antigravity', file: path.join(pluginDir, 'agy-office-hook.js'), result: writeIfChanged(path.join(pluginDir, 'agy-office-hook.js'), script, { dryRun }) });

  const template = JSON.parse(fs.readFileSync(path.join(src, 'hooks.json'), 'utf8'));
  const hooksFile = path.join(pluginDir, 'hooks.json');
  const current = readJsonFile(hooksFile);
  const { 'agent-office': _legacy, ...rest } = current.data || {};
  const merged = { ...rest, 'alifgunadi-office': template['alifgunadi-office'] };
  results.push({ target: 'antigravity', file: hooksFile, result: writeIfChanged(hooksFile, jsonText(merged, current.indent), { dryRun }) });
  return results;
}

function installOpenCode({ root, pluginDir, dryRun }) {
  const plugin = applyRoot(fs.readFileSync(path.join(root, 'adapters', 'opencode', 'alifgunadi-office.js'), 'utf8'), root);
  const file = path.join(pluginDir, 'alifgunadi-office.js');
  const result = writeIfChanged(file, plugin, { dryRun });
  // The plugin used to be called agent-office.js; leaving it would register every event twice.
  const legacy = path.join(pluginDir, 'agent-office.js');
  if (!dryRun && fs.existsSync(legacy)) fs.renameSync(legacy, `${legacy}.bak-${stamp()}`);
  return { target: 'opencode', file, result };
}

function install({ root, home = os.homedir(), targets = TARGETS, dryRun = false, claudeSettings, antigravityDir, opencodeDir }) {
  const report = [];
  if (targets.includes('claude')) {
    report.push(installClaude({ root, settingsPath: claudeSettings || path.join(home, '.claude', 'settings.json'), dryRun }));
  }
  if (targets.includes('antigravity')) {
    report.push(...installAntigravity({ root, pluginDir: antigravityDir || path.join(home, '.gemini', 'config', 'plugins', 'migrated-settings'), dryRun }));
  }
  if (targets.includes('opencode')) {
    report.push(installOpenCode({ root, pluginDir: opencodeDir || path.join(home, '.config', 'opencode', 'plugins'), dryRun }));
  }
  return report;
}

module.exports = { install, mergeClaudeHooks, applyRoot, isOurs, scriptKey, readJsonFile, TARGETS, ROOT_PLACEHOLDER };
