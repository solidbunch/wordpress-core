'use strict';

// Regression test for the ENOBUFS bug: `git show HEAD:./packages.json` used Node's default 1 MiB
// maxBuffer, so once packages.json grew past 1 MiB the git baseline read failed and was silently
// treated as "no baseline available", disabling the LOST-VERSION/SHRUNK checks in --check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const { withTempDir } = require('./helpers');
const { VARIANTS, LICENSE, HOMEPAGE, SUPPORT, CORE_IMPLEMENTATION, SOURCE_URL } = require('../lib/constants');
const { distUrl } = require('../lib/util');

const execFileAsync = promisify(execFile);
const GENERATOR_SCRIPT = path.join(__dirname, '..', 'generate-packages-json.js');
const SHASUM = 'a'.repeat(40);

// Big enough (~600 versions per variant) to push the committed packages.json past 1 MiB, which is
// exactly the threshold that triggered ENOBUFS with Node's default maxBuffer.
const VERSION_COUNT = 600;

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildEntry(variant, version) {
  const entry = {
    name: variant.name,
    version,
    type: 'wordpress-core',
    description: variant.description,
    keywords: [...variant.keywords],
    homepage: HOMEPAGE,
    license: LICENSE,
    support: { ...SUPPORT },
    require: { php: '>=7.4' },
    provide: { [CORE_IMPLEMENTATION]: version }
  };
  if (variant.hasSource) entry.source = { type: 'git', url: SOURCE_URL, reference: version };
  entry.dist = { type: 'zip', url: distUrl(variant, version), shasum: SHASUM };
  return entry;
}

// Builds a valid packages.json body with `count` strictly descending versions per variant.
function buildPackages(count) {
  const packages = {};
  for (const variant of VARIANTS) packages[variant.name] = {};
  for (let i = count; i >= 1; i--) {
    const version = `${i}.0`;
    for (const variant of VARIANTS) packages[variant.name][version] = buildEntry(variant, version);
  }
  return packages;
}

function writePackages(dir, packages) {
  const file = path.join(dir, 'packages.json');
  fs.writeFileSync(file, `${JSON.stringify({ packages }, null, 2)}\n`);
  return file;
}

// Sets up a git repository in `dir` with repo-local (never global) user.name/user.email, then
// commits packages.json as the baseline. Returns the file size in bytes for the caller to assert
// the >1 MiB precondition.
function initRepoWithBaseline(dir, packages) {
  const file = writePackages(dir, packages);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', 'packages.json'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
  return fs.statSync(file).size;
}

// Commits an invalid-JSON packages.json as the baseline at HEAD, in a repo-local git identity.
function initRepoWithInvalidBaseline(dir) {
  fs.writeFileSync(path.join(dir, 'packages.json'), '{ this is not valid json');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', 'packages.json'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'invalid baseline'], { cwd: dir });
}

async function runCheck(cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GENERATOR_SCRIPT, '--check'], { cwd, env: process.env });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('check compares against a >1 MiB git baseline without hitting ENOBUFS', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const packages = buildPackages(VERSION_COUNT);
    const size = initRepoWithBaseline(dir, packages);
    assert.ok(size > 1024 * 1024, `fixture packages.json must exceed 1 MiB, was ${size} bytes`);

    const result = await runCheck(dir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Compared against HEAD:packages\.json for lost or dropped versions/);
    assert.match(result.stdout, /packages\.json passes all invariants/);
  });
});

test('check reports LOST-VERSION and exits 1 when a version is dropped relative to a >1 MiB baseline', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const packages = buildPackages(VERSION_COUNT);
    const size = initRepoWithBaseline(dir, packages);
    assert.ok(size > 1024 * 1024, `fixture packages.json must exceed 1 MiB, was ${size} bytes`);

    // Drop one version from the working copy (uncommitted) relative to the committed baseline.
    const droppedVersion = '300.0';
    for (const variant of VARIANTS) delete packages[variant.name][droppedVersion];
    writePackages(dir, packages);

    const result = await runCheck(dir);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(`LOST-VERSION: .* ${droppedVersion.replace('.', '\\.')} was in the previous file`));
  });
});

test('check fails fatally, not silently, when the committed baseline is invalid JSON', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    initRepoWithInvalidBaseline(dir);

    // The working copy has a valid packages.json (uncommitted), only the committed baseline is broken.
    const packages = buildPackages(1);
    writePackages(dir, packages);

    const result = await runCheck(dir);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /^FATAL: HEAD:packages\.json is not valid JSON: /m);
    assert.equal((result.stderr.match(/FATAL: /g) ?? []).length, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /No git baseline available/);
  });
});

test('check falls back to "no git baseline" and exits 0 when there is no git repository', async () => {
  await withTempDir(async (dir) => {
    const packages = buildPackages(1);
    writePackages(dir, packages);

    const result = await runCheck(dir);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /No git baseline available; lost or dropped versions were not checked/);
  });
});
