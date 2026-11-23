'use strict';
// Starts the AlifGunadi Office server in the background if it is not already running.
// Used by the Claude Code SessionStart hook and the optional Windows logon task.
// Always exits 0 and prints nothing to stdout (SessionStart stdout is added to Claude's context).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.ALIFGUNADI_OFFICE_PORT) || 4317;
const PROBE_TIMEOUT_MS = 500;
const HARD_EXIT_MS = 3000;
const SERVER_PATH = path.join(__dirname, 'server.js');
const { STOPPED_MARKER, LOG_PATH } = require('./lib/paths');
const { rotateIfLarge } = require('./lib/logfile');

setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();

// An explicit start clears a previous manual Stop from the UI.
try {
  fs.unlinkSync(STOPPED_MARKER);
} catch {
  // Marker absent.
}

// Hook payload arrives on stdin; it is not needed here.
process.stdin.on('error', () => {});
process.stdin.resume();

function startServer() {
  let out = 'ignore';
  rotateIfLarge(LOG_PATH);
  try {
    out = fs.openSync(LOG_PATH, 'a');
  } catch {
    // Logging is optional; start without it.
  }
  try {
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: __dirname,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.on('error', () => process.exit(0));
    child.unref();
  } catch {
    // Never fail the caller.
  }
  process.exit(0);
}

// Another service on the port must not count as a running office: check the /state shape.
// Older office versions have no "app" marker, so a desks+log pair is accepted too.
function isOffice(body) {
  try {
    const json = JSON.parse(body);
    return Boolean(json) && (json.app === 'alifgunadi-office' || (Boolean(json.desks) && Array.isArray(json.log)));
  } catch {
    return false;
  }
}

const probe = http.get({ host: '127.0.0.1', port: PORT, path: '/state', timeout: PROBE_TIMEOUT_MS }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    if (body.length < 1024 * 1024) body += chunk;
  });
  res.on('end', () => {
    if (res.statusCode === 200 && isOffice(body)) process.exit(0);
    else startServer();
  });
});
probe.on('timeout', () => probe.destroy());
probe.on('error', startServer);
