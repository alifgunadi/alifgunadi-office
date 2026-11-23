'use strict';
// Files shared by server.js, hook.js and ensure-server.js.
// ALIFGUNADI_OFFICE_DATA_DIR lets tests (and unusual setups) keep them out of the real temp directory.

const os = require('node:os');
const path = require('node:path');

const DATA_DIR = process.env.ALIFGUNADI_OFFICE_DATA_DIR || os.tmpdir();

module.exports = {
  DATA_DIR,
  // Written on a manual Stop; hook.js will not auto-revive the server while it exists.
  // ensure-server.js removes it (new Claude Code session, start-office.ps1, logon task).
  STOPPED_MARKER: path.join(DATA_DIR, 'alifgunadi-office.stopped'),
  LOG_PATH: path.join(DATA_DIR, 'alifgunadi-office.log'),
};
