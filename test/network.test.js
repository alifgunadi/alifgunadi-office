'use strict';
// Which addresses and Host names the server accepts besides this computer (lib/network.js), and what a real
// server does with a bad value. Nothing here needs Tailscale: only the rules are checked.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveNetwork, isTailnetAddress } = require('../lib/network');
const { startServer } = require('./helpers');

describe('isTailnetAddress', () => {
  it('accepts exactly 100.64.0.0 to 100.127.255.255', () => {
    for (const ip of ['100.64.0.0', '100.100.100.100', '100.127.255.255']) assert.equal(isTailnetAddress(ip), true, ip);
    for (const ip of ['100.63.255.255', '100.128.0.0', '99.100.0.1', '101.64.0.1']) assert.equal(isTailnetAddress(ip), false, ip);
  });

  it('refuses wildcards, LAN and loopback addresses, IPv6 and junk', () => {
    for (const ip of ['0.0.0.0', '::', '::1', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.16.0.1', 'localhost', '', '100.64.0', '100.64.0.1.5', '100.64.0.256']) {
      assert.equal(isTailnetAddress(ip), false, ip);
    }
  });
});

describe('resolveNetwork', () => {
  it('serves only this computer by default', () => {
    const n = resolveNetwork({}, 4317);
    assert.deepEqual(n.listen, []);
    assert.deepEqual([...n.hosts].sort(), ['127.0.0.1:4317', 'localhost:4317']);
    assert.deepEqual([...n.origins].sort(), ['http://127.0.0.1:4317', 'http://localhost:4317']);
    assert.deepEqual(n.problems, []);
  });

  it('adds a Tailscale address to the listen list, the Host check and the Origin check', () => {
    const n = resolveNetwork({ ALIFGUNADI_OFFICE_LISTEN: '100.101.102.103' }, 4400);
    assert.deepEqual(n.listen, ['100.101.102.103']);
    assert.ok(n.hosts.has('100.101.102.103:4400'));
    assert.ok(n.origins.has('http://100.101.102.103:4400'));
    assert.ok(n.hosts.has('127.0.0.1:4400'));
  });

  it('takes several addresses, trims blanks and drops duplicates', () => {
    const n = resolveNetwork({ ALIFGUNADI_OFFICE_LISTEN: ' 100.64.0.1 , ,100.64.0.2,100.64.0.1' }, 4317);
    assert.deepEqual(n.listen, ['100.64.0.1', '100.64.0.2']);
  });

  it('refuses a wildcard or LAN address and reports it, leaving the safe default', () => {
    const n = resolveNetwork({ ALIFGUNADI_OFFICE_LISTEN: '0.0.0.0,192.168.1.20,::,100.64.0.9' }, 4317);
    assert.deepEqual(n.listen, ['100.64.0.9']);
    assert.equal(n.problems.length, 3);
    assert.ok(!n.hosts.has('192.168.1.20:4317') && !n.hosts.has('0.0.0.0:4317'));
  });

  it('allows a host name only when listed, lowercased and with the port', () => {
    const n = resolveNetwork({ ALIFGUNADI_OFFICE_ALLOWED_HOSTS: 'My-PC.tail1234.ts.net' }, 4317);
    assert.ok(n.hosts.has('my-pc.tail1234.ts.net:4317'));
    assert.ok(n.origins.has('http://my-pc.tail1234.ts.net:4317'));
    assert.deepEqual(n.problems, []);
  });

  it('refuses wildcards, paths, ports, schemes, IP addresses and overlong names as host names', () => {
    const bad = ['*.ts.net', 'evil.com/path', 'evil.com:80', 'http://evil.com', '192.168.1.20', 'a b.com', '-x.com', `${'a'.repeat(64)}.com`];
    const n = resolveNetwork({ ALIFGUNADI_OFFICE_ALLOWED_HOSTS: bad.join(',') }, 4317);
    assert.equal(n.problems.length, bad.length);
    assert.deepEqual([...n.hosts].sort(), ['127.0.0.1:4317', 'localhost:4317']);
  });
});

describe('a real server with a bad ALIFGUNADI_OFFICE_LISTEN', () => {
  it('ignores the wildcard, keeps serving this computer and still rejects a foreign Host', async () => {
    const srv = await startServer({ ALIFGUNADI_OFFICE_LISTEN: '0.0.0.0', ALIFGUNADI_OFFICE_ALLOWED_HOSTS: 'my-pc.example.ts.net' });
    try {
      assert.equal((await srv.request('GET', '/state')).status, 200);
      assert.equal((await srv.request('GET', '/state', { headers: { Host: '192.168.1.20:' + srv.port } })).status, 403);
      // A listed name is trusted by the Host check even without an extra address: that is what the rule says.
      assert.equal((await srv.request('GET', '/state', { headers: { Host: `my-pc.example.ts.net:${srv.port}` } })).status, 200);
    } finally {
      await srv.stop();
    }
  });

  it('still starts when a Tailscale address is not on this computer', async () => {
    const srv = await startServer({ ALIFGUNADI_OFFICE_LISTEN: '100.127.255.254' });
    try {
      assert.equal((await srv.request('GET', '/state')).status, 200);
      assert.equal(srv.exit.code, undefined);
    } finally {
      await srv.stop();
    }
  });
});
