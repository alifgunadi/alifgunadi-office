'use strict';
// Forwards a Claude Code hook payload to the local AlifGunadi Office server.
// Design constraints:
// - Never blocks or fails Claude Code: always exits 0, prints nothing to stdout.
// - Sends only the minimum fields the office needs (no prompts, file contents, or full commands).

const http = require('node:http');

const PORT = Number(process.env.ALIFGUNADI_OFFICE_PORT) || 4317;
const MAX_STDIN_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 800;
const HARD_EXIT_MS = 1500;

setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
  if (raw.length > MAX_STDIN_BYTES) process.exit(0);
});
process.stdin.on('end', forward);
process.stdin.on('error', () => process.exit(0));

// A hook must never surface an error to the host agent, whatever the payload looks like.
process.on('uncaughtException', () => process.exit(0));

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

// Only the file name is forwarded, never the directory (paths can reveal user names and project layout).
function fileName(value) {
  const name = str(value, 1000);
  return name ? name.split(/[\\/]/).pop().slice(0, 100) : undefined;
}

// Only the program name is forwarded: leading VAR=value assignments (often secrets) are skipped,
// and so are the directories in front of the program and every argument.
function programName(command) {
  const tokens = command.trim().split(/\s+/);
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  const first = tokens[0];
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return 'env';
  return first.split(/[\\/]/).pop().slice(0, 40);
}

function slimToolInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  const slim = {};
  const file = fileName(input.file_path || input.path || input.notebook_path);
  if (file) slim.file_path = file;
  if (typeof input.command === 'string' && input.command.trim()) slim.command = programName(input.command);
  const pattern = str(input.pattern, 40);
  if (pattern) slim.pattern = pattern;
  const subagent = str(input.subagent_type, 80);
  if (subagent) slim.subagent_type = subagent;
  return slim;
}

function forward() {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  // JSON "null", arrays and scalars are valid JSON but not hook payloads.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) process.exit(0);

  const event = {
    v: 1,
    source: 'claude-code',
    hook_event_name: str(payload.hook_event_name, 64),
    session_id: str(payload.session_id, 128),
    agent_id: str(payload.agent_id, 128),
    agent_type: str(payload.agent_type, 64),
    teammate_name: str(payload.teammate_name, 64),
    tool_name: str(payload.tool_name, 128),
    notification_type: str(payload.notification_type, 64),
    tool_input: slimToolInput(payload.tool_input),
  };
  const body = JSON.stringify(event);

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
      res.on('end', () => process.exit(0));
    },
  );
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.on('error', () => {
    // Server is down (e.g. auto-stopped). Revive it when the user is active again.
    if (event.hook_event_name === 'UserPromptSubmit') reviveServer();
    process.exit(0);
  });
  req.end(body);
}

function reviveServer() {
  try {
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    // Respect a manual Stop from the UI; a new session (SessionStart) clears it.
    if (fs.existsSync(require('./lib/paths').STOPPED_MARKER)) return;
    spawn(process.execPath, [path.join(__dirname, 'ensure-server.js')], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // Never fail Claude Code.
  }
}
