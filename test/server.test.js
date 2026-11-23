'use strict';
// Black-box tests: a real server.js process on a free port with an isolated data dir.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, sleep } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.stop();
});

const GUARD = { 'X-AlifGunadi-Office': '1' };
const post = (body, headers = GUARD) => srv.request('POST', '/event', { body, headers });

describe('identity and normal flow', () => {
  it('/state carries the identity marker', async () => {
    const state = await srv.state();
    assert.equal(state.app, 'alifgunadi-office');
    assert.equal(state.schema, 1);
    assert.ok(state.desks.main);
    assert.ok(Array.isArray(state.log));
  });

  it('serves the page', async () => {
    const res = await srv.request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  });

  it('turns a hook event into desk activity', async () => {
    assert.equal((await srv.event({ hook_event_name: 'PreToolUse', session_id: 'n1', tool_name: 'Edit', tool_input: { file_path: 'C:\\x\\b.js' } })).status, 204);
    assert.equal((await srv.state()).desks.main.activity, 'Edit b.js');
  });

  it('answers unknown routes with 404', async () => {
    assert.equal((await srv.request('GET', '/nope')).status, 404);
  });
});

describe('GET /health', () => {
  it('reports liveness and basic counts', async () => {
    const res = await srv.request('GET', '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.ok, true);
    assert.equal(body.app, 'alifgunadi-office');
    assert.equal(body.schema, 1);
    assert.equal(typeof body.uptime_s, 'number');
    assert.equal(body.desks, 12);
  });

  it('follows the same Host check as every other route', async () => {
    assert.equal((await srv.request('GET', '/health', { headers: { Host: 'evil.example' } })).status, 403);
  });
});

describe('POST /event validation', () => {
  it('requires the X-AlifGunadi-Office header', async () => {
    assert.equal((await post({ hook_event_name: 'Stop' }, {})).status, 403);
  });

  it('rejects bodies that are not events with 400', async () => {
    for (const body of ['null', '[]', '"x"', '5', '{', '{}', '{"hook_event_name":5}']) {
      assert.equal((await post(body)).status, 400, body);
    }
  });

  it('rejects oversized bodies', async () => {
    const res = await post(JSON.stringify({ hook_event_name: 'x', pad: 'a'.repeat(70 * 1024) }));
    assert.ok(res.status === 413 || res.error, `status ${res.status} error ${res.error}`);
  });

  it('survives wrong-typed fields (used to crash the process)', async () => {
    const payloads = [
      { hook_event_name: 'PreToolUse', tool_name: 5 },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 42, command: { a: 1 }, pattern: [] } },
      { hook_event_name: 'PreToolUse', agent_id: {}, agent_type: 7, teammate_name: [], notification_type: 9 },
    ];
    for (const payload of payloads) assert.equal((await srv.event(payload)).status, 204);
    assert.equal(srv.exit.code, undefined);
    assert.equal((await srv.request('GET', '/state')).status, 200);
  });

  it('does not create prototype-related desks', async () => {
    for (const id of ['__proto__', 'constructor']) await srv.event({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: id });
    const keys = Object.keys((await srv.state()).desks);
    assert.ok(!keys.includes('__proto__') && !keys.includes('constructor'));
  });

  it('flattens nested agent ids', async () => {
    await srv.event({ hook_event_name: 'SubagentStart', agent_id: 'n1', agent_type: 'engineering/lead-dba' });
    assert.equal((await srv.state()).desks['lead-dba'].status, 'working');
  });

  it('caps guest desks', async () => {
    for (let i = 0; i < 30; i++) await srv.event({ hook_event_name: 'SubagentStart', agent_id: `g${i}`, agent_type: `guest-${i}` });
    const guests = Object.values((await srv.state()).desks).filter((d) => d.guest).length;
    assert.ok(guests > 0 && guests <= 12, `guests=${guests}`);
  });
});

describe('Host, Origin and fetch-metadata checks', () => {
  const evil = { Host: 'evil.example' };

  it('rejects a foreign Host on every route (DNS rebinding)', async () => {
    for (const [method, url] of [['GET', '/'], ['GET', '/state'], ['GET', '/events'], ['POST', '/event'], ['POST', '/control/stop'], ['POST', '/control/restart']]) {
      const res = await srv.request(method, url, { headers: { ...evil, ...GUARD }, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${url}`);
    }
    assert.equal(srv.exit.code, undefined);
  });

  it('rejects a foreign or null Origin', async () => {
    assert.equal((await srv.request('GET', '/state', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await srv.request('GET', '/state', { headers: { Origin: 'null' } })).status, 403);
  });

  it('rejects Sec-Fetch-Site cross-site', async () => {
    assert.equal((await srv.request('GET', '/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });

  it('lets a cross-site page send the user here by a link (a top-level GET navigation), and nothing else cross-site', async () => {
    const nav = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    assert.equal((await srv.request('GET', '/', { headers: nav })).status, 200, 'opening the page from a link');
    // anything that is not a plain navigation stays refused
    assert.equal((await srv.request('GET', '/state', { headers: { ...nav, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403, 'fetch');
    assert.equal((await srv.request('GET', '/events', { headers: { ...nav, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } })).status, 403, 'event stream');
    assert.equal((await srv.request('GET', '/', { headers: { ...nav, 'Sec-Fetch-Dest': 'iframe' } })).status, 403, 'embedding in a frame');
    assert.equal((await srv.request('POST', '/event', { body: {}, headers: { ...nav, 'X-AlifGunadi-Office': '1' } })).status, 403, 'a post, even with the right header');
    assert.equal((await srv.request('POST', '/control/stop', { headers: { ...nav, 'X-AlifGunadi-Office': '1' } })).status, 403, 'the control routes');
    assert.equal((await srv.request('GET', '/', { headers: { ...nav, Origin: 'http://evil.example' } })).status, 403, 'a foreign Origin still counts');
    assert.equal((await srv.request('GET', '/', { headers: { ...nav, Host: 'evil.example' } })).status, 403, 'a foreign Host still counts');
  });

  it('accepts the office origin and localhost', async () => {
    const own = { Origin: `http://127.0.0.1:${srv.port}`, 'Sec-Fetch-Site': 'same-origin' };
    assert.equal((await srv.request('GET', '/state', { headers: own })).status, 200);
    assert.equal((await srv.request('GET', '/state', { headers: { Host: `localhost:${srv.port}` } })).status, 200);
  });
});

describe('SSE', () => {
  function openStreams(port, n) {
    return new Promise((resolve) => {
      const statuses = [];
      const responses = [];
      let done = 0;
      const finish = () => {
        if (++done === n) resolve({ statuses, close: () => responses.forEach((r) => r.destroy()) });
      };
      for (let i = 0; i < n; i++) {
        http
          .get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
            statuses.push(res.statusCode);
            responses.push(res);
            finish();
          })
          .on('error', () => {
            statuses.push('error');
            finish();
          });
      }
    });
  }

  it('sends a snapshot on connect and caps the number of clients', async () => {
    const { statuses, close } = await openStreams(srv.port, 18);
    assert.equal(statuses.filter((s) => s === 200).length, 16);
    assert.equal(statuses.filter((s) => s === 429).length, 2);
    close();
    await sleep(100);
  });

  it('streams the identity-marked snapshot', async () => {
    const first = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/events' }, (res) => {
        res.setEncoding('utf8');
        res.once('data', (chunk) => {
          res.destroy();
          resolve(chunk);
        });
      });
    });
    assert.match(first, /^data: \{"app":"alifgunadi-office","schema":1/);
  });
});

describe('control endpoints', () => {
  it('Stop writes the marker in the data dir and shuts the server down', async () => {
    const own = await startServer();
    try {
      assert.equal((await own.request('POST', '/control/stop', { headers: GUARD })).status, 202);
      for (let i = 0; i < 30 && own.exit.code === undefined; i++) await sleep(100);
      assert.equal(own.exit.code, 0);
      assert.ok(fs.existsSync(path.join(own.dataDir, 'alifgunadi-office.stopped')));
    } finally {
      await own.stop();
    }
  });

  it('control endpoints need the guard header', async () => {
    assert.equal((await srv.request('POST', '/control/stop')).status, 403);
    assert.equal((await srv.request('POST', '/control/restart')).status, 403);
  });
});

describe('sessions across the HTTP boundary', () => {
  it('SessionEnd of one session does not reset another session that is working', async () => {
    const own = await startServer();
    try {
      await own.event({ hook_event_name: 'SessionStart', session_id: 'A' });
      await own.event({ hook_event_name: 'SessionStart', session_id: 'B' });
      await own.event({ hook_event_name: 'PreToolUse', session_id: 'B', tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
      await own.event({ hook_event_name: 'SessionEnd', session_id: 'A' });
      const main = (await own.state()).desks.main;
      assert.equal(main.status, 'working');
      assert.equal(main.activity, 'Edit a.js');
    } finally {
      await own.stop();
    }
  });
});
