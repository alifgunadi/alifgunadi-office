'use strict';
// Where the server may be reached from, besides this computer (127.0.0.1 is always served).
//
// Off by default. ALIFGUNADI_OFFICE_LISTEN lists extra addresses to listen on, but only Tailscale addresses
// (100.64.0.0/10) are accepted: a wildcard (0.0.0.0, ::), a LAN address or anything else is refused, so a typo can
// never open the office to the whole Wi-Fi. ALIFGUNADI_OFFICE_ALLOWED_HOSTS lists extra host names (for example the
// MagicDNS name of this computer) that may appear in the Host header; the Host and Origin checks stay in force.
// A bad entry is skipped and reported in `problems`, which leaves the server on the safe side (fewer addresses).

const net = require('node:net');

const LOOPBACK = '127.0.0.1';
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Tailscale hands out IPv4 addresses from 100.64.0.0/10, which is 100.64.0.0 to 100.127.255.255.
function isTailnetAddress(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function resolveNetwork(env, port) {
  const listen = [];
  const hosts = new Set([`${LOOPBACK}:${port}`, `localhost:${port}`]);
  const problems = [];

  for (const ip of parseList(env.ALIFGUNADI_OFFICE_LISTEN)) {
    if (!isTailnetAddress(ip)) {
      problems.push(`ALIFGUNADI_OFFICE_LISTEN: "${ip}" ignored, only Tailscale addresses (100.64.0.0/10) are accepted`);
      continue;
    }
    if (listen.includes(ip)) continue;
    listen.push(ip);
    hosts.add(`${ip}:${port}`);
  }

  for (const entry of parseList(env.ALIFGUNADI_OFFICE_ALLOWED_HOSTS)) {
    const name = entry.toLowerCase();
    if (net.isIP(name) || !HOSTNAME.test(name)) {
      problems.push(`ALIFGUNADI_OFFICE_ALLOWED_HOSTS: "${entry}" ignored, expected a host name such as my-pc.tail1234.ts.net`);
      continue;
    }
    hosts.add(`${name}:${port}`);
  }

  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return { listen, hosts, origins, problems };
}

module.exports = { resolveNetwork, isTailnetAddress, LOOPBACK };
