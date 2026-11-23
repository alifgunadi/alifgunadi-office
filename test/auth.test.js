'use strict';
// The per-user token and the session cookie (lib/auth.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COOKIE_NAME, tokenPath, loadOrCreateToken, createAuth, SESSION_TTL_MS } = require('../lib/auth');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-auth-')), 'sub', 'token');
const req = (cookie) => ({ headers: cookie === undefined ? {} : { cookie } });

describe('token file', () => {
  it('is made on first use: 64 hex characters, and it is the same on the next use', () => {
    const file = tmpFile();
    const a = loadOrCreateToken(file);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(loadOrCreateToken(file), a);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), a);
  });

  it('two users get different tokens', () => {
    assert.notEqual(loadOrCreateToken(tmpFile()), loadOrCreateToken(tmpFile()));
  });

  it('a damaged file is replaced by a fresh token', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not a token');
    assert.match(loadOrCreateToken(file), /^[0-9a-f]{64}$/);
  });

  it('two servers starting at once end up with the same token', () => {
    const file = tmpFile();
    const tokens = new Set();
    for (let i = 0; i < 20; i++) tokens.add(loadOrCreateToken(file));
    assert.equal(tokens.size, 1);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), [...tokens][0]);
  });

  it('leaves no temporary file behind', () => {
    const file = tmpFile();
    loadOrCreateToken(file);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['token']);
  });

  it('is in the profile of the user (LOCALAPPDATA) unless a file is named', () => {
    assert.equal(tokenPath({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), path.join('C:\\Users\\x\\AppData\\Local', 'AlifGunadiOffice', 'token'));
    assert.equal(tokenPath({ ALIFGUNADI_OFFICE_TOKEN_FILE: '/tmp/t', LOCALAPPDATA: 'C:\\x' }), '/tmp/t');
  });
});

describe('session cookie', () => {
  const token = 'a'.repeat(64);
  const cookieOf = (r) => r.cookie.split(';')[0];

  it('the right token is traded for a cookie that is HttpOnly and SameSite=Strict, lasts 12 hours and does not contain the token', () => {
    const auth = createAuth(token);
    const r = auth.exchange(token);
    assert.equal(r.ok, true);
    assert.match(r.cookie, /^alifgunadi_office_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
    assert.ok(!r.cookie.includes(token));
  });

  it('that cookie is accepted, and only that one', () => {
    const auth = createAuth(token);
    const value = cookieOf(auth.exchange(token));
    assert.equal(auth.isAuthed(req(value)), true);
    assert.equal(auth.isAuthed(req(value + ' ; other=1')), true, 'among other cookies');
    assert.equal(auth.isAuthed(req('other=1; ' + value)), true);
    assert.equal(auth.isAuthed(req(COOKIE_NAME + '=' + 'b'.repeat(64))), false, 'a wrong value');
    assert.equal(auth.isAuthed(req(COOKIE_NAME + '=' + token)), false, 'the token itself is not a session');
    assert.equal(auth.isAuthed(req('')), false);
    assert.equal(auth.isAuthed(req()), false, 'no Cookie header');
    assert.equal(auth.isAuthed(req('x' + value)), false, 'a different cookie name');
    assert.equal(auth.isAuthed(req(COOKIE_NAME + '=')), false);
  });

  it('a second cookie of the same name planted by another port does not lock the real session out', () => {
    const auth = createAuth(token);
    const value = cookieOf(auth.exchange(token));
    assert.equal(auth.isAuthed(req(COOKIE_NAME + '=' + 'c'.repeat(64) + '; ' + value)), true);
  });

  it('a cookie made by another server (another token) is not accepted', () => {
    const mine = createAuth(token), theirs = createAuth('c'.repeat(64));
    assert.equal(mine.isAuthed(req(cookieOf(theirs.exchange('c'.repeat(64))))), false);
  });

  it('does not survive a restart or 12 hours: a leaked cookie stops working', () => {
    const first = createAuth(token);
    const value = cookieOf(first.exchange(token, 1000));
    assert.equal(createAuth(token).isAuthed(req(value)), false, 'a new server process knows no session');
    assert.equal(first.isAuthed(req(value), 1000 + SESSION_TTL_MS - 1), true);
    assert.equal(first.isAuthed(req(value), 1000 + SESSION_TTL_MS), false);
  });

  it('every login is a new session, and logout ends it', () => {
    const auth = createAuth(token);
    const a = cookieOf(auth.exchange(token)), b = cookieOf(auth.exchange(token));
    assert.notEqual(a, b);
    auth.logout(req(a));
    assert.equal(auth.isAuthed(req(a)), false);
    assert.equal(auth.isAuthed(req(b)), true);
  });

  it('keeps at most 32 sessions; the oldest is dropped', () => {
    const auth = createAuth(token);
    const first = cookieOf(auth.exchange(token, 1000));
    for (let i = 0; i < 32; i++) auth.exchange(token, 1001 + i);
    assert.equal(auth.isAuthed(req(first), 2000), false);
  });

  it('a wrong, empty, missing or oversized token is refused', () => {
    const auth = createAuth(token);
    for (const bad of ['b'.repeat(64), '', undefined, null, 5, 'x'.repeat(5000), token.slice(1)]) assert.equal(auth.exchange(bad).ok, false, String(bad).slice(0, 10));
  });

  it('wrong tries never block the right token (no lockout for a local process to abuse)', () => {
    const auth = createAuth(token);
    for (let i = 0; i < 50; i++) assert.equal(auth.exchange('nope', 1000 + i).ok, false);
    assert.equal(auth.exchange(token, 2000).ok, true);
  });
});
