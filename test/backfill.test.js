'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { withTempDir } = require('./helpers');

const execFileAsync = promisify(execFile);
const GENERATOR_SCRIPT = path.join(__dirname, '..', 'generate-packages-json.js');

const SHASUM_NO_CONTENT = 'b'.repeat(40);
const SHASUM_FULL = 'c'.repeat(40);

function legacyPackages() {
  return {
    'solidbunch/wordpress-core-no-content': {
      '6.9': {
        name: 'solidbunch/wordpress-core-no-content',
        version: '6.9',
        type: 'wordpress-core',
        license: 'GPL-2.0-or-later',
        require: { php: '>=7.4' },
        dist: { type: 'zip', url: 'https://downloads.wordpress.org/release/wordpress-6.9-no-content.zip', shasum: SHASUM_NO_CONTENT },
        extra: { mysql_version: '5.5.5' }
      },
      '6.8': {
        name: 'solidbunch/wordpress-core-no-content',
        version: '6.8',
        type: 'wordpress-core',
        license: 'GPL-2.0-or-later',
        require: { php: '>=7.4' },
        dist: { type: 'zip', url: 'https://downloads.wordpress.org/release/wordpress-6.8-no-content.zip', shasum: SHASUM_NO_CONTENT }
      }
    },
    'solidbunch/wordpress-core': {
      '6.9': {
        name: 'solidbunch/wordpress-core',
        version: '6.9',
        type: 'wordpress-core',
        license: 'GPL-2.0-or-later',
        require: { php: '>=7.4' },
        dist: { type: 'zip', url: 'https://downloads.wordpress.org/release/wordpress-6.9.zip', shasum: SHASUM_FULL },
        extra: { mysql_version: '5.5.5' }
      },
      '6.8': {
        name: 'solidbunch/wordpress-core',
        version: '6.8',
        type: 'wordpress-core',
        license: 'GPL-2.0-or-later',
        require: { php: '>=7.4' },
        dist: { type: 'zip', url: 'https://downloads.wordpress.org/release/wordpress-6.8.zip', shasum: SHASUM_FULL }
      }
    }
  };
}

function writePackages(dir, packages) {
  const file = path.join(dir, 'packages.json');
  fs.writeFileSync(file, `${JSON.stringify({ packages }, null, 2)}\n`);
  return file;
}

// Runs generate-packages-json.js --backfill as a child process rooted at `cwd` (PACKAGES_FILE is
// a fixed relative constant, not env-overridable); never throws on non-zero exit.
async function runBackfill(cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GENERATOR_SCRIPT, '--backfill'], { cwd, env: process.env });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('backfill rebuilds every entry with the new metadata fields and loses no version', async () => {
  await withTempDir(async (dir) => {
    const file = writePackages(dir, legacyPackages());
    const result = await runBackfill(dir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /solidbunch\/wordpress-core-no-content: 2 versions rebuilt/);
    assert.match(result.stdout, /solidbunch\/wordpress-core: 2 versions rebuilt/);

    const rebuilt = JSON.parse(fs.readFileSync(file, 'utf8')).packages;
    for (const [name, entries] of Object.entries(rebuilt)) {
      assert.deepEqual(Object.keys(entries), Object.keys(legacyPackages()[name]));
      for (const [version, entry] of Object.entries(entries)) {
        assert.equal(entry.description !== undefined, true);
        assert.deepEqual(entry.provide, { 'wordpress/core-implementation': version });
        assert.equal(entry.homepage, 'https://wordpress.org');
        assert.equal('source' in entry, name === 'solidbunch/wordpress-core');
      }
    }
  });
});

test('backfill is idempotent: a second run leaves the file byte-identical', async () => {
  await withTempDir(async (dir) => {
    const file = writePackages(dir, legacyPackages());
    const first = await runBackfill(dir);
    assert.equal(first.exitCode, 0, first.stderr);
    const afterFirst = fs.readFileSync(file, 'utf8');

    const second = await runBackfill(dir);
    assert.equal(second.exitCode, 0, second.stderr);
    const afterSecond = fs.readFileSync(file, 'utf8');

    assert.equal(afterSecond, afterFirst);
  });
});

test('backfill exits 1 and writes nothing when a stored dist.shasum is malformed', async () => {
  await withTempDir(async (dir) => {
    const bad = legacyPackages();
    bad['solidbunch/wordpress-core']['6.9'].dist.shasum = 'not-a-shasum';
    const file = writePackages(dir, bad);
    const before = fs.readFileSync(file, 'utf8');

    const result = await runBackfill(dir);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /FATAL:.*dist\.url\/dist\.shasum/);

    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, before, 'packages.json must be untouched on failure');
  });
});

test('backfill exits 1 and writes nothing when a stored dist.url cannot be normalized', async () => {
  await withTempDir(async (dir) => {
    const bad = legacyPackages();
    bad['solidbunch/wordpress-core-no-content']['6.8'].dist.url = 'not a url';
    const file = writePackages(dir, bad);
    const before = fs.readFileSync(file, 'utf8');

    const result = await runBackfill(dir);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /FATAL:.*dist\.url\/dist\.shasum/);

    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, before, 'packages.json must be untouched on failure');
  });
});
