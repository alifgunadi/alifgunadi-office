'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rotateIfLarge } = require('../lib/logfile');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alifgunadi-office-log-test-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('rotateIfLarge', () => {
  it('leaves a small log alone', () => {
    const file = path.join(dir, 'a.log');
    fs.writeFileSync(file, 'x'.repeat(100));
    assert.equal(rotateIfLarge(file, 1000), false);
    assert.equal(fs.existsSync(`${file}.1`), false);
  });

  it('moves a large log to .1', () => {
    const file = path.join(dir, 'a.log');
    fs.writeFileSync(file, 'x'.repeat(2000));
    assert.equal(rotateIfLarge(file, 1000), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.statSync(`${file}.1`).size, 2000);
  });

  it('keeps only one old generation', () => {
    const file = path.join(dir, 'a.log');
    fs.writeFileSync(file, 'old'.repeat(1000));
    rotateIfLarge(file, 100);
    fs.writeFileSync(file, 'new'.repeat(1000));
    rotateIfLarge(file, 100);
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8').slice(0, 3), 'new');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.log.1']);
  });

  it('ignores a missing file', () => {
    assert.equal(rotateIfLarge(path.join(dir, 'missing.log'), 10), false);
  });
});
