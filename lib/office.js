'use strict';
// The office model: desks, activity log, session tracking and the hook-event state machine.
// No HTTP, no process lifecycle: server.js wires those in through the callbacks, and tests drive
// this module directly.

const path = require('node:path');

// Desk ids and divisions live in one file shared with the page (public/js/roles-shared.js).
const { MAIN_DESK, ROLE_IDS } = require('../public/js/roles-shared');

const SCHEMA_VERSION = 1;
const MAX_LOG_ENTRIES = 100;
const DONE_TO_IDLE_MS = 8000;
const STALE_SESSION_MS = 6 * 60 * 60 * 1000;
const STALE_DESK_MS = 10 * 60 * 1000;
// Limits that keep a misbehaving or hostile local client from growing memory without bound.
const MAX_GUEST_DESKS = 12;
const MAX_TRACKED_IDS = 256; // sessions and active subagents

// Notification types that mean "Claude is blocked on you" besides a permission prompt.
const INPUT_NOTIFICATIONS = new Set(['idle_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']);
const DEFAULT_SOURCE = 'claude-code';

// Internal Claude Code tools that are not meaningful as "work" on a desk.
const INTERNAL_TOOL_LABELS = { SubagentHandback: 'reporting back' };

function shortToolName(name) {
  if (typeof name !== 'string' || !name) return 'tool';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `${parts[1] || 'mcp'}:${parts[parts.length - 1]}`;
  }
  return name;
}

function describeTool(name, input) {
  if (Object.hasOwn(INTERNAL_TOOL_LABELS, name)) return INTERNAL_TOOL_LABELS[name];
  const tool = shortToolName(name);
  if (!input) return tool;
  if (input.subagent_type) return `delegate -> ${input.subagent_type}`;
  if (input.file_path) return `${tool} ${path.basename(input.file_path)}`;
  if (input.command) return `${tool} ${input.command}`;
  if (input.pattern) return `${tool} "${input.pattern}"`;
  return tool;
}

// Drops the oldest entries (Map keeps insertion order) once a map grows past its cap.
function capMap(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

/**
 * @param {object} [hooks]
 * @param {() => void} [hooks.onChange] state changed; broadcast it
 * @param {() => void} [hooks.onSessionActivity] an event arrived while sessions are live; cancel any pending shutdown
 * @param {(reason: string) => void} [hooks.onSessionsEmpty] the last known session ended or went stale
 */
function createOffice({ onChange = () => {}, onSessionActivity = () => {}, onSessionsEmpty = () => {} } = {}) {
  // Null-prototype map: desk ids come from untrusted payloads, so "__proto__" must be an ordinary key.
  const state = { desks: Object.create(null), log: [] };
  const activeSubagents = new Map(); // agent_id -> { type, session }
  const sessions = new Map(); // session_id -> lastSeen timestamp
  const deskOwner = new Map(); // deskId -> session_id that last wrote to it
  const idleTimers = new Map(); // deskId -> timeout
  let currentSession; // session of the event being handled

  for (const id of ROLE_IDS) ensureDesk(id);

  function guestDeskCount() {
    let n = 0;
    for (const desk of Object.values(state.desks)) if (desk.guest) n++;
    return n;
  }

  // Returns null when a new guest desk would exceed MAX_GUEST_DESKS; callers then drop the update.
  function ensureDesk(id) {
    if (!state.desks[id]) {
      const guest = !ROLE_IDS.includes(id);
      if (guest && guestDeskCount() >= MAX_GUEST_DESKS) return null;
      state.desks[id] = { id, status: 'idle', activity: '', updatedAt: Date.now(), guest };
    }
    return state.desks[id];
  }

  // Changes a desk without broadcasting, so callers can batch several changes into one update.
  function applyDesk(id, status, activity) {
    const desk = ensureDesk(id);
    if (!desk) return;
    desk.status = status;
    desk.activity = activity || '';
    desk.updatedAt = Date.now();
    if (currentSession) deskOwner.set(id, currentSession);

    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
    if (status === 'done') {
      const timer = setTimeout(() => {
        idleTimers.delete(id);
        if (!state.desks[id] || state.desks[id].status !== 'done') return;
        if (state.desks[id].guest) removeDesk(id);
        else setDesk(id, 'idle', '');
      }, DONE_TO_IDLE_MS);
      timer.unref?.();
      idleTimers.set(id, timer);
    }

    if (activity) {
      state.log.push({ t: desk.updatedAt, desk: id, status, text: activity });
      if (state.log.length > MAX_LOG_ENTRIES) state.log.shift();
    }
  }

  function setDesk(id, status, activity) {
    applyDesk(id, status, activity);
    onChange();
  }

  function removeDesk(id) {
    clearTimeout(idleTimers.get(id));
    idleTimers.delete(id);
    deskOwner.delete(id);
    delete state.desks[id];
    onChange();
  }

  // key is "<source>:<session_id>", so equal session ids from different agent products never collide.
  function trackSession(evt, key) {
    if (evt.hook_event_name === 'SessionEnd') {
      if (key) sessions.delete(key);
      if (sessions.size === 0) onSessionsEmpty('last session ended');
      return;
    }
    onSessionActivity();
    if (key) {
      sessions.set(key, Date.now());
      capMap(sessions, MAX_TRACKED_IDS);
    }
  }

  function isActiveSubagentType(type) {
    for (const sub of activeSubagents.values()) if (sub.type === type) return true;
    return false;
  }

  function resolveDesk(evt) {
    const type = typeof evt.agent_type === 'string' ? evt.agent_type : '';
    if (evt.agent_id) {
      if (activeSubagents.has(evt.agent_id)) return activeSubagents.get(evt.agent_id).type;
      if (type) return type;
    }
    // agent_type without agent_id is the main thread running as an agent (e.g. a plugin's default agent),
    // unless that type is currently running as a subagent.
    if (type && isActiveSubagentType(type)) return type;
    if (typeof evt.teammate_name === 'string' && evt.teammate_name) return evt.teammate_name;
    return MAIN_DESK;
  }

  // One session ending must not wipe desks another live session is using. Only when no session
  // is left (or the event carries no session id, as with older adapters) is everything reset.
  function endSession(sessionId) {
    if (!sessionId || sessions.size === 0) {
      activeSubagents.clear();
      for (const id of Object.keys(state.desks)) applyDesk(id, 'idle', '');
    } else {
      for (const [agentId, sub] of activeSubagents) if (sub.session === sessionId) activeSubagents.delete(agentId);
      for (const [id, owner] of deskOwner) if (owner === sessionId && state.desks[id]) applyDesk(id, 'idle', '');
    }
    onChange();
  }

  function dispatch(evt, key) {
    const desk = resolveDesk(evt);
    switch (evt.hook_event_name) {
      case 'SessionStart': {
        // A second session starting must not wipe the main desk while another live session is busy there.
        const cur = state.desks[MAIN_DESK];
        const owner = deskOwner.get(MAIN_DESK);
        if (cur && (cur.status === 'working' || cur.status === 'waiting') && owner && owner !== key && sessions.has(owner)) break;
        setDesk(MAIN_DESK, 'idle', 'session started');
        break;
      }
      case 'UserPromptSubmit':
        setDesk(MAIN_DESK, 'working', 'thinking...');
        break;
      case 'SubagentStart': {
        const type = evt.agent_type || 'subagent';
        if (evt.agent_id) {
          activeSubagents.set(evt.agent_id, { type, session: key });
          capMap(activeSubagents, MAX_TRACKED_IDS);
        }
        setDesk(type, 'working', 'starting task');
        break;
      }
      case 'SubagentStop': {
        const type = evt.agent_type || activeSubagents.get(evt.agent_id)?.type || 'subagent';
        if (evt.agent_id) activeSubagents.delete(evt.agent_id);
        setDesk(type, 'done', 'task finished');
        break;
      }
      case 'PreToolUse':
        setDesk(desk, 'working', describeTool(evt.tool_name, evt.tool_input));
        break;
      case 'PostToolUseFailure':
        setDesk(desk, 'working', `${shortToolName(evt.tool_name)} failed`);
        break;
      case 'Notification':
        if (evt.notification_type === 'permission_prompt') setDesk(MAIN_DESK, 'waiting', 'needs your approval');
        else if (INPUT_NOTIFICATIONS.has(evt.notification_type)) setDesk(MAIN_DESK, 'waiting', 'waiting for your input');
        break;
      case 'TeammateIdle':
        setDesk(desk, 'idle', 'idle');
        break;
      case 'Stop':
        setDesk(MAIN_DESK, 'done', 'turn finished');
        break;
      case 'StopFailure':
        // The turn ended on an API error (rate limit, auth, ...): Stop never fires, so close the turn here.
        setDesk(MAIN_DESK, 'done', 'turn failed');
        break;
      case 'SessionEnd':
        endSession(key);
        break;
      default:
        break;
    }
  }

  // Entry point for a sanitized event (see lib/sanitize.js).
  function handle(evt) {
    const key = evt.session_id ? `${evt.source || DEFAULT_SOURCE}:${evt.session_id}` : undefined;
    trackSession(evt, key);
    currentSession = key;
    try {
      dispatch(evt, key);
    } finally {
      currentSession = undefined;
    }
  }

  // Safety net for missed events: a desk stuck in working/waiting returns to idle,
  // and guest desks disappear once they have been quiet for a while.
  function sweepDesks(now = Date.now()) {
    for (const desk of Object.values(state.desks)) {
      if (now - desk.updatedAt < STALE_DESK_MS) continue;
      if (desk.guest) removeDesk(desk.id);
      else if (desk.status === 'working' || desk.status === 'waiting') setDesk(desk.id, 'idle', '');
    }
  }

  function sweepSessions(now = Date.now()) {
    let pruned = false;
    for (const [id, lastSeen] of sessions) {
      if (now - lastSeen > STALE_SESSION_MS) {
        sessions.delete(id);
        pruned = true;
      }
    }
    if (pruned && sessions.size === 0) onSessionsEmpty('stale sessions');
  }

  // Identity marker lets clients tell AlifGunadi Office apart from any other service on the port.
  function snapshot() {
    return { app: 'alifgunadi-office', schema: SCHEMA_VERSION, desks: state.desks, log: state.log };
  }

  // Cancels pending timers so a test (or shutdown) does not wait on them.
  function dispose() {
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
  }

  return { handle, snapshot, sweepDesks, sweepSessions, dispose, state, sessions };
}

module.exports = {
  createOffice,
  describeTool,
  shortToolName,
  ROLE_IDS,
  MAIN_DESK,
  MAX_GUEST_DESKS,
  MAX_TRACKED_IDS,
  DONE_TO_IDLE_MS,
  STALE_DESK_MS,
  STALE_SESSION_MS,
};
