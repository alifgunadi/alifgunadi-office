'use strict';
// hook.js runs inside every agent session, so the contract is strict: forward only the allowed
// fields, never print, never fail. These tests run the real script against a capturing server.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ROOT, sleep, freePort } = require('./helpers');

let capture;
let port;
let received;
let dataDir;

before(async () => {
  received = [];
  capture = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ body: JSON.parse(body), headers: req.headers });
      res.writeHead(204).end();
    });
  });
  port = await freePort();
  await new Promise((resolve) => capture.listen(port, '127.0.0.1', resolve));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alifgunadi-office-hook-test-'));
});

after(() => {
  capture.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runHook(input, targetPort = port) {
  return new Promise((resolve) => {
    const before = received.length;
    const child = spawn(process.execPath, [path.join(ROOT, 'hook.js')], {
      env: { ...process.env, ALIFGUNADI_OFFICE_PORT: String(targetPort), ALIFGUNADI_OFFICE_DATA_DIR: dataDir },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', async (code) => {
      await sleep(100);
      resolve({ code, stdout, stderr, sent: received.length > before ? received.at(-1) : null });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const tool = (tool_input, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input, ...extra });

describe('hook.js never disturbs the host agent', () => {
  for (const [label, input] of [['null', 'null'], ['array', '[]'], ['number', '5'], ['string', '"x"'], ['empty', ''], ['garbage', '{{{']]) {
    it(`stdin ${label}: exit 0, nothing printed, nothing sent`, async () => {
      const r = await runHook(input);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
      assert.equal(r.sent, null);
    });
  }

  it('exits 0 with empty stdout when the server is down', async () => {
    const r = await runHook(tool({}), await freePort());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  it('tags events with the envelope (v1, claude-code)', async () => {
    const { v, source } = (await runHook(tool({}))).sent.body;
    assert.deepEqual({ v, source }, { v: 1, source: 'claude-code' });
  });

  it('sends the guard header', async () => {
    const r = await runHook(tool({}));
    assert.equal(r.sent.headers['x-alifgunadi-office'], '1');
  });
});

describe('hook.js privacy', () => {
  it('forwards only the program name of a command', async () => {
    assert.equal((await runHook(tool({ command: 'npm test --flag=x' }))).sent.body.tool_input.command, 'npm');
  });

  it('skips leading VAR=value assignments', async () => {
    assert.equal((await runHook(tool({ command: 'FOO=secret TOKEN=abc npm test' }))).sent.body.tool_input.command, 'npm');
  });

  it('reports "env" when the command is only assignments', async () => {
    assert.equal((await runHook(tool({ command: 'SECRET=onlyassign' }))).sent.body.tool_input.command, 'env');
  });

  it('drops the directory and arguments in front of and after a program', async () => {
    const r = await runHook(tool({ command: 'C:\\Users\\bob\\bin\\tool.exe --password hunter2' }));
    assert.equal(r.sent.body.tool_input.command, 'tool.exe');
    assert.ok(!JSON.stringify(r.sent.body).includes('hunter2'));
  });

  it('forwards file base names only', async () => {
    assert.equal((await runHook(tool({ file_path: 'C:\\Users\\bob\\secret-project\\src\\a.js' }))).sent.body.tool_input.file_path, 'a.js');
    assert.equal((await runHook(tool({ file_path: '/home/bob/x/b.py' }))).sent.body.tool_input.file_path, 'b.py');
    assert.equal((await runHook(tool({ notebook_path: '/n/c.ipynb' }))).sent.body.tool_input.file_path, 'c.ipynb');
  });

  it('caps search patterns at 40 characters', async () => {
    assert.equal((await runHook(tool({ pattern: 'x'.repeat(100) }))).sent.body.tool_input.pattern.length, 40);
  });

  it('never forwards prompts, responses or paths outside the allowlist', async () => {
    const r = await runHook(tool({ command: 'ls' }, { prompt: 'SECRET PROMPT', tool_response: 'SECRET OUTPUT', cwd: 'C:/private', transcript_path: 'C:/t.jsonl' }));
    const sent = JSON.stringify(r.sent.body);
    for (const leaked of ['SECRET PROMPT', 'SECRET OUTPUT', 'C:/private', 't.jsonl']) assert.ok(!sent.includes(leaked), leaked);
    assert.deepEqual(Object.keys(r.sent.body).sort(), ['hook_event_name', 'session_id', 'source', 'tool_input', 'tool_name', 'v']);
  });

  it('drops wrong-typed fields but still delivers the event', async () => {
    const r = await runHook(JSON.stringify({ hook_event_name: 5, tool_name: {}, tool_input: 'str', session_id: [] }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(r.sent.body, { v: 1, source: 'claude-code' });
  });
});

describe('hook.js stop marker', () => {
  it('does not revive the server after a manual Stop', async () => {
    fs.writeFileSync(path.join(dataDir, 'alifgunadi-office.stopped'), 'x');
    const dead = await freePort();
    const r = await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), dead);
    assert.equal(r.code, 0);
    await sleep(500);
    assert.equal(fs.existsSync(path.join(dataDir, 'alifgunadi-office.log')), false);
    fs.rmSync(path.join(dataDir, 'alifgunadi-office.stopped'));
  });
});
