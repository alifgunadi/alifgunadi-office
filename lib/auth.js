'use strict';
// Who may start programs through the office. The page of the office can be read by every account on this PC, so a page cannot be
// trusted by itself. Instead there is one secret per user: a random token in a file in that user's profile (%LOCALAPPDATA%), which
// other accounts cannot read. Whoever opens the page through the launcher (start-office.ps1, the desktop app) hands the token to
// /auth once and gets a session cookie. Everything that runs programs or reads prompts needs that cookie.
//
// A session is a random id the server keeps in memory: it expires after 12 hours and is gone when the server restarts, so a cookie that
// leaks (browsers send cookies to every port on 127.0.0.1) stops working soon. The token itself is never in a cookie.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COOKIE_NAME = 'alifgunadi_office_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;
const MAX_SESSIONS = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;

function tokenPath(env = process.env) {
  if (env.ALIFGUNADI_OFFICE_TOKEN_FILE) return env.ALIFGUNADI_OFFICE_TOKEN_FILE;
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'AlifGunadiOffice', 'token');
}

function readToken(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    return TOKEN_RE.test(existing) ? existing : null;
  } catch { return null; }
}

// The token of this user: read from the file, or made (written next to it first, then linked into place so two servers starting at the
// same moment cannot end up with different tokens) if there is none or it is damaged.
function loadOrCreateToken(file = tokenPath()) {
  const existing = readToken(file);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  try {
    try { fs.linkSync(tmp, file); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const other = readToken(file);
      if (other) return other; // someone else made it first
      fs.renameSync(tmp, file); // a damaged file: replace it
      return token;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already moved */ }
  }
  return token;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // compares equal-length digests, so length is not leaked

// Every value of our cookie in the header. A page on another port of 127.0.0.1 can plant a second cookie of the same name; all are tried.
function cookieValues(req) {
  const header = req.headers.cookie;
  if (!header) return [];
  const out = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) out.push(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(token) {
  const sessions = new Map(); // id -> expiry (ms)
  const prune = (now) => { for (const [id, exp] of sessions) if (exp <= now) sessions.delete(id); };
  return {
    // Does this request carry a live session cookie?
    isAuthed(req, now = Date.now()) {
      return cookieValues(req).some((id) => /^[0-9a-f]{64}$/.test(id) && (sessions.get(id) || 0) > now);
    },
    // Trade the token for a cookie. Returns { ok, cookie } or { ok: false }. A wrong token never blocks a right one: with 256 bits
    // there is nothing to guess, and a lockout would only let any local process keep the real user out.
    exchange(provided, now = Date.now()) {
      if (typeof provided !== 'string' || provided.length === 0 || provided.length > 200 || !sameSecret(provided, token)) return { ok: false };
      prune(now);
      while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // the oldest goes
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, now + SESSION_TTL_MS);
      return { ok: true, cookie: COOKIE_NAME + '=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) };
    },
    logout(req) { for (const id of cookieValues(req)) sessions.delete(id); },
  };
}

module.exports = { COOKIE_NAME, SESSION_TTL_MS, tokenPath, loadOrCreateToken, createAuth };
