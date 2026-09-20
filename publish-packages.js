'use strict';

// Publishes tags to the per-variant Packagist repositories (plan T7.2, backlog 7.2). Each version
// key in packages.json that is not yet tagged in the variant's own repository gets a commit
// (composer.json = the exact packages.json entry, see lib/tag-composer.js) and a lightweight tag
// named exactly like the packages.json key. Configuration is environment-only (contract C4); the
// only supported CLI flag is --dry-run.
//
// This script NEVER deletes a ref and NEVER pushes or tags non-fast-forward: no git invocation
// anywhere below passes any destructive or history-rewriting flag, by construction (also asserted
// by test/publish.test.js, which greps this file's own source for the absence of such flags).
//
// Determining "the default branch" of a variant's repository deliberately does not just clone and
// read `git symbolic-ref --short HEAD`: pushing the very first branch to a freshly
// `git init --bare` remote does not retarget that remote's own symbolic HEAD in the git version this
// was verified against (it stays at git's own built-in default, typically "master", even though we
// deliberately create and push "main"). Trusting `symbolic-ref` after clone would therefore pick the
// wrong, non-existent branch on every run after the first one, silently forking the history. Instead
// the branch name is read from `git ls-remote --heads` (the actual, real branch a previous run
// created) before cloning, and the clone checks that branch out explicitly with `--branch`. Only a
// genuinely empty repository (no heads at all) falls back to the "main" default the plan specifies.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { VARIANTS } = require('./lib/constants');
const { compareVersions } = require('./lib/versions');
const { readPackagesFile } = require('./lib/packages-file');
const { buildTagComposerJson, serializeTagComposerJson } = require('./lib/tag-composer');

const PACKAGES_FILE = process.env.PACKAGES_FILE || 'packages.json';
const PUBLISH_LIMIT = Number(process.env.PUBLISH_LIMIT || 50);
const DEFAULT_BRANCH = 'main';

const [noContentVariant, fullVariant] = VARIANTS;

const REMOTE_ENV_VAR = {
  [fullVariant.name]: 'PUBLISH_REPO_WORDPRESS_CORE',
  [noContentVariant.name]: 'PUBLISH_REPO_WORDPRESS_CORE_NO_CONTENT'
};

const DRY_RUN = process.argv.includes('--dry-run');

// The short name of every branch the remote already has, in `git ls-remote --heads` order.
function remoteHeads(remote) {
  const output = execFileSync('git', ['ls-remote', '--heads', remote], { encoding: 'utf8' }).trim();
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.split('\trefs/heads/')[1])
    .filter(Boolean);
}

// The set of tag names the remote already has (lightweight tags only are ever created here, so the
// `^{}` dereferenced-annotated-tag suffix is stripped defensively rather than expected).
function remoteTags(remote) {
  const output = execFileSync('git', ['ls-remote', '--tags', remote], { encoding: 'utf8' }).trim();
  if (!output) return new Set();
  const tags = output
    .split('\n')
    .map((line) => line.split('\trefs/tags/')[1])
    .filter(Boolean)
    .map((name) => name.replace(/\^\{\}$/, ''));
  return new Set(tags);
}

// Clones (or, for a genuinely empty repository, initializes) the variant's working directory and
// returns the branch name in use.
function prepareWorkingDir(remote, dir) {
  // The variant subdirectory may be left over from an earlier run against the same PUBLISH_WORK_DIR
  // (an explicit env override is a plain working directory, not guaranteed fresh per run). Every run
  // clones the remote's current state from scratch, so any stale clone is simply discarded first.
  fs.rmSync(dir, { recursive: true, force: true });
  const heads = remoteHeads(remote);
  if (heads.length === 0) {
    execFileSync('git', ['init', '--quiet', `--initial-branch=${DEFAULT_BRANCH}`, dir]);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    // The remote has no refs at all yet; this fetch is a documented no-op kept for parity with the
    // plan's algorithm (step 1) rather than for any effect.
    execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: dir });
    return DEFAULT_BRANCH;
  }
  const branch = heads[0];
  execFileSync('git', ['clone', '--quiet', '--branch', branch, remote, dir]);
  return branch;
}

function commitVersion(dir, variant, version, entry) {
  const composerJson = serializeTagComposerJson(buildTagComposerJson(variant, entry));
  fs.writeFileSync(path.join(dir, 'composer.json'), composerJson);
  execFileSync('git', ['add', 'composer.json'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.name=GitHub Actions', '-c', 'user.email=actions@github.com', 'commit', '--quiet', '-m', version],
    { cwd: dir }
  );
  execFileSync('git', ['tag', version], { cwd: dir });
}

// Publishes one variant. Returns nothing; all outcomes are reported via console.log per contract C4.
function publishVariant(variant, versions, workDir) {
  const envVar = REMOTE_ENV_VAR[variant.name];
  const remote = process.env[envVar];
  if (!remote) {
    console.log(`SKIPPED-NO-REMOTE: ${variant.name}`);
    return;
  }

  const dir = path.join(workDir, variant.name.split('/')[1]);
  const branch = prepareWorkingDir(remote, dir);
  const existingTags = remoteTags(remote);

  const sortedVersions = Object.keys(versions).sort(compareVersions);
  const pending = sortedVersions.filter((version) => !existingTags.has(version));

  let created = 0;
  for (const version of sortedVersions) {
    if (existingTags.has(version)) {
      console.log(`EXISTS: ${variant.name} ${version}`);
      continue;
    }
    if (created >= PUBLISH_LIMIT) continue;
    commitVersion(dir, variant, version, versions[version]);
    console.log(`PUBLISHED: ${variant.name} ${version}`);
    created++;
  }

  if (pending.length > PUBLISH_LIMIT) {
    console.log(`LIMIT-REACHED: ${variant.name} after ${created} tag(s)`);
  }

  if (created === 0) return;

  if (DRY_RUN) {
    console.log(`DRY-RUN: would push ${created} new tag(s) and branch ${branch} to ${remote} for ${variant.name}`);
    return;
  }

  execFileSync('git', ['push', '--quiet', remote, `HEAD:${branch}`], { cwd: dir });
  execFileSync('git', ['push', '--quiet', remote, '--tags'], { cwd: dir });
}

function main() {
  const packages = readPackagesFile(PACKAGES_FILE, { required: true });

  const ownWorkDir = !process.env.PUBLISH_WORK_DIR;
  const workDir = process.env.PUBLISH_WORK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'publish-packages-'));

  try {
    for (const variant of VARIANTS) {
      const versions = packages[variant.name] || {};
      publishVariant(variant, versions, workDir);
    }
  } finally {
    if (ownWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, publishVariant, prepareWorkingDir, remoteHeads, remoteTags };
