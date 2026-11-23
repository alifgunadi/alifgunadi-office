'use strict';
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createOffice, describeTool, MAX_GUEST_DESKS, MAX_TRACKED_IDS, DONE_TO_IDLE_MS, STALE_DESK_MS, STALE_SESSION_MS } = require('../lib/office');
const { sanitizeEvent } = require('../lib/sanitize');

let office;
let changes;
let emptied;
let activity;

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  changes = 0;
  emptied = [];
  activity = 0;
  office = createOffice({
    onChange: () => changes++,
    onSessionsEmpty: (reason) => emptied.push(reason),
    onSessionActivity: () => activity++,
  });
});

afterEach(() => {
  office.dispose();
  mock.timers.reset();
});

// Same path the server takes: raw payload -> sanitize -> office.
const send = (raw) => office.handle(sanitizeEvent(raw));
const desk = (id) => office.state.desks[id];

describe('state machine', () => {
  it('starts with the role desks idle', () => {
    assert.equal(desk('main').status, 'idle');
    assert.equal(desk('lead-qa').guest, false);
    assert.equal(Object.keys(office.state.desks).length, 12);
  });

  it('walks main through a turn', () => {
    send({ hook_event_name: 'SessionStart', session_id: 's1' });
    assert.equal(desk('main').activity, 'session started');
    send({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
    assert.deepEqual([desk('main').status, desk('main').activity], ['working', 'thinking...']);
    send({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'C:\\x\\y\\b.js' } });
    assert.equal(desk('main').activity, 'Edit b.js');
    send({ hook_event_name: 'Stop', session_id: 's1' });
    assert.equal(desk('main').status, 'done');
    mock.timers.tick(DONE_TO_IDLE_MS);
    assert.equal(desk('main').status, 'idle');
  });

  it('routes tool events of a subagent to its own desk', () => {
    send({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'lead-qa' });
    send({ hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'a1', tool_name: 'Grep', tool_input: { pattern: 'todo' } });
    assert.equal(desk('lead-qa').activity, 'Grep "todo"');
    assert.equal(desk('main').activity, '');
    send({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1' });
    assert.equal(desk('lead-qa').status, 'done');
  });

  it('describes delegation, mcp tools, commands and internal tools', () => {
    assert.equal(describeTool('Task', { subagent_type: 'lead-ui' }), 'delegate -> lead-ui');
    assert.equal(describeTool('mcp__figma__get_file', {}), 'figma:get_file');
    assert.equal(describeTool('Bash', { command: 'npm' }), 'Bash npm');
    assert.equal(describeTool('SubagentHandback'), 'reporting back');
    assert.equal(describeTool('__proto__'), '__proto__');
    assert.equal(describeTool(undefined), 'tool');
  });

  it('marks permission and idle prompts as waiting on main', () => {
    send({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    assert.deepEqual([desk('main').status, desk('main').activity], ['waiting', 'needs your approval']);
    send({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    assert.equal(desk('main').activity, 'waiting for your input');
  });

  it('treats the newer "blocked on you" notification types as waiting', () => {
    for (const notification_type of ['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']) {
      send({ hook_event_name: 'UserPromptSubmit' });
      send({ hook_event_name: 'Notification', notification_type });
      assert.deepEqual([desk('main').status, desk('main').activity], ['waiting', 'waiting for your input'], notification_type);
    }
  });

  it('closes the turn when it ends on an API error (StopFailure)', () => {
    send({ hook_event_name: 'UserPromptSubmit' });
    send({ hook_event_name: 'StopFailure' });
    assert.deepEqual([desk('main').status, desk('main').activity], ['done', 'turn failed']);
  });

  it('ignores unknown events and unknown notification types', () => {
    const before = JSON.stringify(office.snapshot());
    send({ hook_event_name: 'SomethingNew' });
    send({ hook_event_name: 'Notification', notification_type: 'whatever' });
    assert.equal(JSON.stringify(office.snapshot()), before);
  });

  it('keeps the activity log capped', () => {
    for (let i = 0; i < 150; i++) send({ hook_event_name: 'PreToolUse', tool_name: `T${i}` });
    assert.equal(office.state.log.length, 100);
    assert.equal(office.state.log.at(-1).text, 'T149');
  });
});

describe('guest desks', () => {
  it('creates a guest for an unknown agent type and removes it after it finishes', () => {
    send({ hook_event_name: 'SubagentStart', agent_id: 'g', agent_type: 'plugin:custom' });
    assert.equal(desk('plugin:custom').guest, true);
    send({ hook_event_name: 'SubagentStop', agent_id: 'g', agent_type: 'plugin:custom' });
    mock.timers.tick(DONE_TO_IDLE_MS);
    assert.equal(desk('plugin:custom'), undefined);
  });

  it('flattens nested ids to the role desk', () => {
    send({ hook_event_name: 'SubagentStart', agent_id: 'n', agent_type: 'engineering/lead-dba' });
    assert.equal(desk('lead-dba').status, 'working');
    assert.equal(desk('lead-dba').guest, false);
  });

  it('caps the number of guest desks', () => {
    for (let i = 0; i < 40; i++) send({ hook_event_name: 'SubagentStart', agent_id: `g${i}`, agent_type: `guest-${i}` });
    assert.equal(Object.values(office.state.desks).filter((d) => d.guest).length, MAX_GUEST_DESKS);
  });

  it('never turns prototype-related ids into desks', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) send({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: id });
    for (const id of ['__proto__', 'constructor', 'prototype']) assert.equal(Object.hasOwn(office.state.desks, id), false);
    assert.equal(Object.getPrototypeOf(office.state.desks), null);
    assert.equal(({}).status, undefined);
    assert.equal(Object.prototype.status, undefined);
  });

  it('bounds the tracked subagents and sessions', () => {
    for (let i = 0; i < MAX_TRACKED_IDS + 50; i++) {
      send({ hook_event_name: 'SubagentStart', session_id: `s${i}`, agent_id: `a${i}`, agent_type: 'lead-qa' });
    }
    assert.equal(office.sessions.size, MAX_TRACKED_IDS);
  });
});

describe('sessions', () => {
  it('a session starting later does not wipe the main desk another live session is working on', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    send({ hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
    send({ hook_event_name: 'SessionStart', session_id: 'B', source: 'opencode' });
    assert.equal(desk('main').status, 'working');
    assert.equal(desk('main').activity, 'Edit a.js');
  });

  it('a session starting on an idle main desk still shows "session started"', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    assert.equal(desk('main').activity, 'session started');
  });

  it('SessionEnd of one session leaves the work of another live session alone', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    send({ hook_event_name: 'SessionStart', session_id: 'B' });
    send({ hook_event_name: 'SubagentStart', session_id: 'B', agent_id: 'b1', agent_type: 'lead-qa' });
    send({ hook_event_name: 'PreToolUse', session_id: 'B', tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
    send({ hook_event_name: 'SessionEnd', session_id: 'A' });
    assert.equal(desk('lead-qa').status, 'working');
    assert.equal(desk('main').status, 'working');
    assert.deepEqual(emptied, []);
  });

  it('SessionEnd resets only the desks the ending session wrote to', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    send({ hook_event_name: 'SessionStart', session_id: 'B' });
    send({ hook_event_name: 'SubagentStart', session_id: 'A', agent_id: 'a1', agent_type: 'lead-ui' });
    send({ hook_event_name: 'SubagentStart', session_id: 'B', agent_id: 'b1', agent_type: 'lead-qa' });
    send({ hook_event_name: 'SessionEnd', session_id: 'A' });
    assert.equal(desk('lead-ui').status, 'idle');
    assert.equal(desk('lead-qa').status, 'working');
    // A's subagent is forgotten, B's still routes tool events to its desk.
    send({ hook_event_name: 'PreToolUse', session_id: 'B', agent_id: 'b1', tool_name: 'Read' });
    assert.equal(desk('lead-qa').activity, 'Read');
  });

  it('equal session ids from different sources are different sessions', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'same', source: 'claude-code' });
    send({ hook_event_name: 'SessionStart', session_id: 'same', source: 'opencode' });
    assert.equal(office.sessions.size, 2);
    send({ hook_event_name: 'SessionEnd', session_id: 'same', source: 'opencode' });
    assert.equal(office.sessions.size, 1);
    assert.deepEqual(emptied, []);
  });

  it('SessionEnd of one source leaves another source working', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'x', source: 'claude-code' });
    send({ hook_event_name: 'SubagentStart', session_id: 'x', source: 'claude-code', agent_id: 'c1', agent_type: 'lead-qa' });
    send({ hook_event_name: 'SessionStart', session_id: 'x', source: 'antigravity' });
    send({ hook_event_name: 'SubagentStart', session_id: 'x', source: 'antigravity', agent_id: 'g1', agent_type: 'lead-ui' });
    send({ hook_event_name: 'SessionEnd', session_id: 'x', source: 'antigravity' });
    assert.equal(desk('lead-qa').status, 'working');
    assert.equal(desk('lead-ui').status, 'idle');
  });

  it('the last SessionEnd resets every desk and reports no sessions', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    send({ hook_event_name: 'SubagentStart', session_id: 'A', agent_id: 'a1', agent_type: 'lead-qa' });
    send({ hook_event_name: 'SessionEnd', session_id: 'A' });
    assert.ok(Object.values(office.state.desks).every((d) => d.status === 'idle' || d.status === 'done'));
    assert.equal(desk('lead-qa').status, 'idle');
    assert.deepEqual(emptied, ['last session ended']);
  });

  it('a SessionEnd without a session id resets everything (older adapters)', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    send({ hook_event_name: 'SessionStart', session_id: 'B' });
    send({ hook_event_name: 'PreToolUse', session_id: 'B', tool_name: 'Edit' });
    send({ hook_event_name: 'SessionEnd' });
    assert.equal(desk('main').status, 'idle');
  });

  it('broadcasts once for a SessionEnd, not once per desk', () => {
    send({ hook_event_name: 'SessionStart', session_id: 'A' });
    changes = 0;
    send({ hook_event_name: 'SessionEnd', session_id: 'A' });
    assert.equal(changes, 1);
  });

  it('any other event cancels a pending shutdown', () => {
    send({ hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Read' });
    assert.equal(activity, 1);
    send({ hook_event_name: 'SessionEnd', session_id: 'A' });
    assert.equal(activity, 1);
  });

  it('prunes sessions that went silent and then reports no sessions', () => {
    send({ hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Read' });
    mock.timers.tick(STALE_SESSION_MS + 1);
    office.sweepSessions();
    assert.equal(office.sessions.size, 0);
    assert.deepEqual(emptied, ['stale sessions']);
  });
});

describe('stale desk sweep', () => {
  it('returns a stuck working desk to idle', () => {
    send({ hook_event_name: 'PreToolUse', session_id: 'A', tool_name: 'Read' });
    mock.timers.tick(STALE_DESK_MS + 1);
    office.sweepDesks();
    assert.equal(desk('main').status, 'idle');
  });

  it('removes a quiet guest desk', () => {
    send({ hook_event_name: 'SubagentStart', agent_id: 'g', agent_type: 'guest-x' });
    mock.timers.tick(STALE_DESK_MS + 1);
    office.sweepDesks();
    assert.equal(desk('guest-x'), undefined);
  });
});

describe('snapshot', () => {
  it('carries the identity marker and schema version', () => {
    const snap = office.snapshot();
    assert.equal(snap.app, 'alifgunadi-office');
    assert.equal(snap.schema, 1);
    assert.ok(Array.isArray(snap.log));
  });
});
