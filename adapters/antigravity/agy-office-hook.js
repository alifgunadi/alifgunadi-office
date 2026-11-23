'use strict';
// Antigravity lifecycle hook adapter for AlifGunadi Office (127.0.0.1:4317).
// Never blocks Antigravity: always outputs valid JSON and exits 0 within 1.5s.
// Install with `node install.js --target antigravity`; the installer fills in the repo location below.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.ALIFGUNADI_OFFICE_PORT) || 4317;
const ROOT = process.env.ALIFGUNADI_OFFICE_ROOT || '__ALIFGUNADI_OFFICE_ROOT__';
const ENSURE_SERVER = `${ROOT}/ensure-server.js`;
const STATE_FILE = path.join(process.env.ALIFGUNADI_OFFICE_DATA_DIR || os.tmpdir(), 'agy-alifgunadi-office-subagents.json');
const MAX_STDIN_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 800;
const HARD_EXIT_MS = 1500;

let raw = '';
let finished = false;

function respondAndExit(hookEventName) {
  if (finished) return;
  finished = true;
  const out = hookEventName === 'Stop' ? { decision: 'stop' } : {};
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

setTimeout(() => respondAndExit(''), HARD_EXIT_MS).unref();
process.on('uncaughtException', () => respondAndExit(''));

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
  if (raw.length > MAX_STDIN_BYTES) respondAndExit('');
});
process.stdin.on('end', () => {
  handle().catch(() => respondAndExit(''));
});
process.stdin.on('error', () => respondAndExit(''));

function loadSubagents() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSubagents(map) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(map), 'utf8');
  } catch {
    // ignore
  }
}

function postEvent(event) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ v: 1, source: 'antigravity', ...event });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path: '/event',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-AlifGunadi-Office': '1',
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

// Same privacy rules as hook.js: file base name, program name and a short pattern only.
function baseName(value) {
  return typeof value === 'string' && value ? value.split(/[\\/]/).pop().slice(0, 100) : undefined;
}

function programName(command) {
  const tokens = command.trim().split(/\s+/);
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return 'env';
  return tokens[0].split(/[\\/]/).pop().slice(0, 40);
}

function slimArgs(args) {
  if (!args || typeof args !== 'object') return undefined;
  const slim = {};
  const file = baseName(args.Path || args.TargetFile || args.file_path || args.path);
  if (file) slim.file_path = file;
  if (typeof args.CommandLine === 'string' && args.CommandLine.trim()) slim.command = programName(args.CommandLine);
  if (typeof args.Query === 'string') slim.pattern = args.Query.slice(0, 40);
  if (typeof args.TypeName === 'string') slim.subagent_type = args.TypeName.slice(0, 80);
  return slim;
}

async function handle() {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return respondAndExit('');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return respondAndExit('');

  const eventName = typeof payload.hookEventName === 'string' ? payload.hookEventName : '';
  const sessionId = typeof payload.conversationId === 'string' && payload.conversationId ? payload.conversationId.slice(0, 128) : 'agy';
  const events = [];

  if (eventName === 'SessionStart') {
    if (fs.existsSync(ENSURE_SERVER)) {
      try {
        const child = spawn(process.execPath, [ENSURE_SERVER], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', () => {});
        child.unref();
      } catch {
        // ignore
      }
    }
    events.push({ hook_event_name: 'SessionStart', session_id: sessionId });
  } else if (eventName === 'PreInvocation') {
    events.push({ hook_event_name: 'UserPromptSubmit', session_id: sessionId });
  } else if (eventName === 'PostToolUse') {
    const toolName = payload.toolCall && typeof payload.toolCall.name === 'string' && payload.toolCall.name ? payload.toolCall.name : 'tool';
    const args = payload.toolCall && payload.toolCall.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
    const toolInput = slimArgs(args);

    if (payload.error) {
      events.push({ hook_event_name: 'PostToolUseFailure', session_id: sessionId, tool_name: toolName, tool_input: toolInput });
    } else {
      events.push({ hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: toolName, tool_input: toolInput });
    }

    if (toolName === 'invoke_subagent' && typeof args.TypeName === 'string' && args.TypeName) {
      const subType = args.TypeName.slice(0, 80);
      const agentId = `${sessionId}:${subType}`;
      const map = loadSubagents();
      const list = Array.isArray(map[sessionId]) ? map[sessionId] : [];
      if (!list.includes(subType)) list.push(subType);
      map[sessionId] = list;
      saveSubagents(map);

      events.push({ hook_event_name: 'SubagentStart', session_id: sessionId, agent_id: agentId, agent_type: subType });
    }
  } else if (eventName === 'Stop') {
    const map = loadSubagents();
    const list = Array.isArray(map[sessionId]) ? map[sessionId] : [];
    for (const subType of list) {
      events.push({ hook_event_name: 'SubagentStop', session_id: sessionId, agent_id: `${sessionId}:${subType}`, agent_type: subType });
    }
    if (list.length > 0) {
      delete map[sessionId];
      saveSubagents(map);
    }
    events.push({ hook_event_name: 'Stop', session_id: sessionId });
  }

  for (const evt of events) {
    await postEvent(evt);
  }

  respondAndExit(eventName);
}
