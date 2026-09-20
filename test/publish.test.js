'use strict';

// Offline end-to-end tests for T7.2 (plan backlog 7.2): publish-packages.js against real local bare
// git repositories (never a network remote). The script is run as a child process, exactly as the
// workflow (T7.3) would run it, with PUBLISH_REPO_WORDPRESS_CORE / PUBLISH_REPO_WORDPRESS_CORE_NO_CONTENT
// pointed at throwaway `git init --bare` directories under a temp dir - a filesystem path is a valid
// git remote. Nothing here touches this repository's own git history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { withTempDir } = require('./helpers');
const { VARIANTS } = require('../lib/constants');
const { distUrl } = require('../lib/util');
const { buildTagComposerJson } = require('../lib/tag-composer');

const SCRIPT = path.join(__dirname, '..', 'publish-packages.js');
const SHASUM = 'a'.repeat(40);
const [noContent, full] = VARIANTS;

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
    homepage: 'https://wordpress.org',
    license: 'GPL-2.0-or-later',
    support: { issues: 'https://github.com/solidbunch/wordpress-core/issues', source: 'https://github.com/solidbunch/wordpress-core' },
    require: { php: '>=7.4' },
    provide: { 'wordpress/core-implementation': version }
  };
  if (variant.hasSource) entry.source = { type: 'git', url: 'https://github.com/WordPress/WordPress.git', reference: version };
  entry.dist = { type: 'zip', url: distUrl(variant, version), shasum: SHASUM };
  entry.extra = { mysql_version: '5.5.5' };
  return entry;
}

function buildPackages(versions) {
  const packages = {};
  for (const variant of VARIANTS) {
    packages[variant.name] = {};
    for (const version of versions) packages[variant.name][version] = buildEntry(variant, version);
  }
  return packages;
}

function writePackages(file, versions) {
  fs.writeFileSync(file, `${JSON.stringify({ packages: buildPackages(versions) }, null, 2)}\n`);
}

function initBareRepos(dir) {
  const fullRepo = path.join(dir, 'full.git');
  const ncRepo = path.join(dir, 'nc.git');
  execFileSync('git', ['init', '--bare', '--quiet', fullRepo]);
  execFileSync('git', ['init', '--bare', '--quiet', ncRepo]);
  return { fullRepo, ncRepo };
}

function runPublish(dir, { fullRepo, ncRepo, packagesFile, extraEnv = {}, args = [] }) {
  const env = { ...process.env, PACKAGES_FILE: packagesFile, ...extraEnv };
  if (fullRepo !== undefined) env.PUBLISH_REPO_WORDPRESS_CORE = fullRepo;
  else delete env.PUBLISH_REPO_WORDPRESS_CORE;
  if (ncRepo !== undefined) env.PUBLISH_REPO_WORDPRESS_CORE_NO_CONTENT = ncRepo;
  else delete env.PUBLISH_REPO_WORDPRESS_CORE_NO_CONTENT;

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function listTags(repo) {
  const output = execFileSync('git', ['ls-remote', '--tags', repo], { encoding: 'utf8' }).trim();
  if (!output) return new Map();
  const tags = new Map();
  for (const line of output.split('\n')) {
    const [sha, ref] = line.split('\t');
    tags.set(ref.replace('refs/tags/', ''), sha);
  }
  return tags;
}

function showComposerJson(repo, tag) {
  const raw = execFileSync('git', ['show', `${tag}:composer.json`], { cwd: repo, encoding: 'utf8' });
  return JSON.parse(raw);
}

function branchLog(repo, branch) {
  return execFileSync('git', ['log', '--format=%s', branch], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

test('publish-packages.js source contains no destructive or history-rewriting git flags', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /--force/);
  assert.doesNotMatch(source, /push -f/);
  assert.doesNotMatch(source, /tag -f/);
  assert.doesNotMatch(source, /--delete/);
});

test('publish-packages.js tags every version, tags parse and deep-equal buildTagComposerJson, commits are ascending, no-content has no source', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const { fullRepo, ncRepo } = initBareRepos(dir);
    const packagesFile = path.join(dir, 'packages.json');
    const versions = ['6.0', '6.1', '6.2'];
    writePackages(packagesFile, versions);

    const result = runPublish(dir, { fullRepo, ncRepo, packagesFile });
    assert.equal(result.exitCode, 0, result.stderr);

    for (const [variant, repo] of [[full, fullRepo], [noContent, ncRepo]]) {
      const tags = listTags(repo);
      assert.deepEqual([...tags.keys()].sort(), [...versions].sort());

      for (const version of versions) {
        const manifest = showComposerJson(repo, version);
        const expected = buildTagComposerJson(variant, buildEntry(variant, version));
        assert.deepEqual(manifest, expected);
        if (variant === noContent) assert.equal('source' in manifest, false);
      }

      const log = branchLog(repo, 'main');
      const commitVersions = [...log].reverse();
      assert.deepEqual(commitVersions, versions);
    }
  });
});

test('publish-packages.js re-run is a no-op: all EXISTS, no new commits/tags, exit 0, SHAs unchanged', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const { fullRepo, ncRepo } = initBareRepos(dir);
    const packagesFile = path.join(dir, 'packages.json');
    const versions = ['6.0', '6.1', '6.2'];
    writePackages(packagesFile, versions);

    const first = runPublish(dir, { fullRepo, ncRepo, packagesFile });
    assert.equal(first.exitCode, 0, first.stderr);

    const tagsBefore = { full: listTags(fullRepo), nc: listTags(ncRepo) };

    const second = runPublish(dir, { fullRepo, ncRepo, packagesFile });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /PUBLISHED:/);
    for (const version of versions) {
      assert.match(second.stdout, new RegExp(`EXISTS: ${full.name.replace('/', '\\/')} ${version}`));
      assert.match(second.stdout, new RegExp(`EXISTS: ${noContent.name.replace('/', '\\/')} ${version}`));
    }

    const tagsAfter = { full: listTags(fullRepo), nc: listTags(ncRepo) };
    assert.deepEqual(tagsAfter.full, tagsBefore.full);
    assert.deepEqual(tagsAfter.nc, tagsBefore.nc);
  });
});

test('publish-packages.js adding one version publishes exactly one new tag per variant, previous tags unchanged', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const { fullRepo, ncRepo } = initBareRepos(dir);
    const packagesFile = path.join(dir, 'packages.json');
    const versions = ['6.0', '6.1', '6.2'];
    writePackages(packagesFile, versions);

    const first = runPublish(dir, { fullRepo, ncRepo, packagesFile });
    assert.equal(first.exitCode, 0, first.stderr);

    const tagsBefore = { full: listTags(fullRepo), nc: listTags(ncRepo) };

    writePackages(packagesFile, [...versions, '6.3']);
    const second = runPublish(dir, { fullRepo, ncRepo, packagesFile });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal((second.stdout.match(/PUBLISHED:/g) ?? []).length, 2);
    assert.match(second.stdout, new RegExp(`PUBLISHED: ${full.name.replace('/', '\\/')} 6\\.3`));
    assert.match(second.stdout, new RegExp(`PUBLISHED: ${noContent.name.replace('/', '\\/')} 6\\.3`));

    const tagsAfter = { full: listTags(fullRepo), nc: listTags(ncRepo) };
    for (const version of versions) {
      assert.equal(tagsAfter.full.get(version), tagsBefore.full.get(version));
      assert.equal(tagsAfter.nc.get(version), tagsBefore.nc.get(version));
    }
    assert.ok(tagsAfter.full.has('6.3'));
    assert.ok(tagsAfter.nc.has('6.3'));
  });
});

test('publish-packages.js PUBLISH_LIMIT caps new tags per variant per run and logs LIMIT-REACHED', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const { fullRepo, ncRepo } = initBareRepos(dir);
    const packagesFile = path.join(dir, 'packages.json');
    writePackages(packagesFile, ['6.0', '6.1', '6.2']);

    const result = runPublish(dir, { fullRepo, ncRepo, packagesFile, extraEnv: { PUBLISH_LIMIT: '1' } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal((result.stdout.match(/PUBLISHED:/g) ?? []).length, 2);
    assert.match(result.stdout, new RegExp(`LIMIT-REACHED: ${full.name.replace('/', '\\/')} after 1 tag\\(s\\)`));
    assert.match(result.stdout, new RegExp(`LIMIT-REACHED: ${noContent.name.replace('/', '\\/')} after 1 tag\\(s\\)`));

    assert.deepEqual([...listTags(fullRepo).keys()], ['6.0']);
    assert.deepEqual([...listTags(ncRepo).keys()], ['6.0']);
  });
});

test('publish-packages.js skips a variant whose remote env var is unset, still publishes the other, exit 0', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const { fullRepo } = initBareRepos(dir);
    const packagesFile = path.join(dir, 'packages.json');
    writePackages(packagesFile, ['6.0']);

    const result = runPublish(dir, { fullRepo, ncRepo: undefined, packagesFile });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`SKIPPED-NO-REMOTE: ${noContent.name.replace('/', '\\/')}`));
    assert.match(result.stdout, new RegExp(`PUBLISHED: ${full.name.replace('/', '\\/')} 6\\.0`));
    assert.ok(listTags(fullRepo).has('6.0'));
  });
});

test('publish-packages.js --dry-run performs every local step but leaves the bare repos untouched', { skip: !hasGit() }, async () => {
  await withTempDir(async (dir) => {
    const { fullRepo, ncRepo } = initBareRepos(dir);
    const packagesFile = path.join(dir, 'packages.json');
    writePackages(packagesFile, ['6.0', '6.1']);

    const before = { full: execFileSync('git', ['ls-remote', '--tags', fullRepo], { encoding: 'utf8' }), nc: execFileSync('git', ['ls-remote', '--tags', ncRepo], { encoding: 'utf8' }) };

    const result = runPublish(dir, { fullRepo, ncRepo, packagesFile, args: ['--dry-run'] });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN:/);

    const after = { full: execFileSync('git', ['ls-remote', '--tags', fullRepo], { encoding: 'utf8' }), nc: execFileSync('git', ['ls-remote', '--tags', ncRepo], { encoding: 'utf8' }) };
    assert.equal(after.full, before.full);
    assert.equal(after.nc, before.nc);
  });
});
