'use strict';
// The Antigravity and OpenCode adapters are separate programs that talk to the office over
// POST /event. These tests run them for real against a capturing server and check what they send.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, sleep, startCapture } = require('./helpers');

let capture;
let dataDir;

before(async () => {
  capture = await startCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alifgunadi-office-adapter-test-'));
  // Set before the OpenCode adapter is imported: it reads the port once at load.
  process.env.ALIFGUNADI_OFFICE_PORT = String(capture.port);
  process.env.ALIFGUNADI_OFFICE_ROOT = dataDir; // no ensure-server.js here, so adapters never start a server
});

after(async () => {
  await capture.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Antigravity adapter', () => {
  const script = path.join(ROOT, 'adapters', 'antigravity', 'agy-office-hook.js');

  function runAdapter(input) {
    return new Promise((resolve) => {
      const before = capture.received.length;
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, ALIFGUNADI_OFFICE_PORT: String(capture.port), ALIFGUNADI_OFFICE_ROOT: dataDir, ALIFGUNADI_OFFICE_DATA_DIR: dataDir },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr, sent: capture.received.slice(before).map((r) => r.body) }));
      child.stdin.on('error', () => {});
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    });
  }

  it('answers {} and exits 0 for payloads it cannot use', async () => {
    for (const input of ['', 'null', '[]', '{{{', '5']) {
      const r = await runAdapter(input);
      assert.equal(r.code, 0, input);
      assert.equal(r.stdout, '{}', input);
      assert.equal(r.stderr, '', input);
      assert.deepEqual(r.sent, [], input);
    }
  });

  it('tags events with the antigravity envelope', async () => {
    const r = await runAdapter({ hookEventName: 'PreInvocation', conversationId: 'c1' });
    assert.deepEqual(r.sent, [{ v: 1, source: 'antigravity', hook_event_name: 'UserPromptSubmit', session_id: 'c1' }]);
  });

  it('maps a tool call and keeps only file base names and program names', async () => {
    let r = await runAdapter({ hookEventName: 'PostToolUse', conversationId: 'c1', toolCall: { name: 'view_file', args: { Path: 'C:\\Users\\bob\\secret\\a.js' } } });
    assert.equal(r.sent[0].hook_event_name, 'PreToolUse');
    assert.equal(r.sent[0].tool_input.file_path, 'a.js');
    r = await runAdapter({ hookEventName: 'PostToolUse', conversationId: 'c1', toolCall: { name: 'run_command', args: { CommandLine: 'TOKEN=abc C:\\bin\\npm.cmd test --password x' } } });
    assert.equal(r.sent[0].tool_input.command, 'npm.cmd');
    assert.ok(!JSON.stringify(r.sent).includes('abc') && !JSON.stringify(r.sent).includes('password'));
  });

  it('reports a failed tool call as PostToolUseFailure', async () => {
    const r = await runAdapter({ hookEventName: 'PostToolUse', conversationId: 'c1', error: 'boom', toolCall: { name: 'run_command', args: {} } });
    assert.equal(r.sent[0].hook_event_name, 'PostToolUseFailure');
  });

  it('starts a subagent on invoke_subagent and stops it on Stop', async () => {
    let r = await runAdapter({ hookEventName: 'PostToolUse', conversationId: 'c2', toolCall: { name: 'invoke_subagent', args: { TypeName: 'lead-qa' } } });
    assert.deepEqual(r.sent.map((e) => e.hook_event_name), ['PreToolUse', 'SubagentStart']);
    assert.equal(r.sent[1].agent_type, 'lead-qa');
    assert.equal(r.sent[1].agent_id, 'c2:lead-qa');
    r = await runAdapter({ hookEventName: 'Stop', conversationId: 'c2' });
    assert.deepEqual(r.sent.map((e) => e.hook_event_name), ['SubagentStop', 'Stop']);
    assert.equal(r.stdout, '{"decision":"stop"}');
  });
});

describe('OpenCode adapter', () => {
  let plugin;
  let events;
  let toolHooks;
  let cleanup;

  before(async () => {
    const mod = await import(pathToFileURL(path.join(ROOT, 'adapters', 'opencode', 'alifgunadi-office.js')).href);
    plugin = mod.default;
    const queue = [];
    let wake;
    events = {
      push(e) {
        queue.push(e);
        wake?.();
      },
    };
    toolHooks = {};
    cleanup = plugin.setup({
      event: {
        async *subscribe({ signal }) {
          while (!signal.aborted) {
            while (queue.length) yield queue.shift();
            await new Promise((resolve) => {
              wake = resolve;
              signal.addEventListener('abort', resolve, { once: true });
            });
          }
        },
      },
      tool: { hook: async (name, fn) => (toolHooks[name] = fn) },
    });
  });

  after(() => cleanup?.());

  // Returns as soon as `count` events have arrived. The deadline is generous on purpose: it only
  // matters when the machine is slow (a shared CI runner), and a passing run never waits for it.
  const lastSent = async (count = 1) => {
    const deadline = Date.now() + 10_000;
    while (capture.received.length < count && Date.now() < deadline) await sleep(10);
    return capture.received;
  };

  // The adapter posts without waiting, so arrival order is not guaranteed: look events up by content.
  const named = (bodies, name) => bodies.find((b) => b.hook_event_name === name || b.tool_name === name);

  it('exposes the plugin shape OpenCode loads', () => {
    assert.equal(plugin.id, 'alifgunadi-office');
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(typeof cleanup, 'function');
  });

  it('does nothing when OpenCode offers no event API', () => {
    assert.equal(plugin.setup({}), undefined);
  });

  it('translates session events and tags them with the opencode envelope', async () => {
    const before = capture.received.length;
    events.push({ type: 'session.created', data: { sessionID: 'ses_1' } });
    events.push({ type: 'permission.asked', data: { sessionID: 'ses_1' } });
    const got = await lastSent(before + 2);
    const mine = got.slice(before).map((r) => r.body);
    assert.deepEqual(named(mine, 'SessionStart'), { v: 1, source: 'opencode', hook_event_name: 'SessionStart', session_id: 'ses_1' });
    const note = named(mine, 'Notification');
    assert.deepEqual([note.hook_event_name, note.notification_type], ['Notification', 'permission_prompt']);
  });

  it('sends the guard header', async () => {
    assert.equal(capture.received.at(-1).headers['x-alifgunadi-office'], '1');
  });

  it('keeps tool input private: base name, program name, short pattern', async () => {
    const before = capture.received.length;
    toolHooks['execute.before']({ sessionID: 'ses_1', tool: 'read', input: { filePath: 'C:\\Users\\bob\\proj\\src\\a.ts' } });
    toolHooks['execute.before']({ sessionID: 'ses_1', tool: 'bash', input: { command: 'KEY=secret npm run build --token=zzz' } });
    toolHooks['execute.before']({ sessionID: 'ses_1', tool: 'grep', input: { pattern: 'p'.repeat(100) } });
    const mine = (await lastSent(before + 3)).slice(before).map((r) => r.body);
    assert.equal(named(mine, 'read').tool_input.file_path, 'a.ts');
    assert.equal(named(mine, 'bash').tool_input.command, 'npm');
    assert.equal(named(mine, 'grep').tool_input.pattern.length, 40);
    assert.ok(!JSON.stringify(mine).includes('secret') && !JSON.stringify(mine).includes('zzz'));
  });

  it('maps task calls to SubagentStart/Stop with the desk id of the agent', async () => {
    const before = capture.received.length;
    toolHooks['execute.before']({ sessionID: 'ses_1', tool: 'task', input: { subagent_type: 'engineering/lead-dba' } });
    toolHooks['execute.after']({ sessionID: 'ses_1', tool: 'task' });
    const mine = (await lastSent(before + 2)).slice(before).map((r) => r.body);
    const start = named(mine, 'SubagentStart'), stop = named(mine, 'SubagentStop');
    assert.deepEqual([start.agent_type, stop.agent_type], ['lead-dba', 'lead-dba']);
    assert.equal(start.agent_id, stop.agent_id);
  });
});
