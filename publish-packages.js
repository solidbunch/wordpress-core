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
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN || '';

const [noContentVariant, fullVariant] = VARIANTS;

const REMOTE_ENV_VAR = {
  [fullVariant.name]: 'PUBLISH_REPO_WORDPRESS_CORE',
  [noContentVariant.name]: 'PUBLISH_REPO_WORDPRESS_CORE_NO_CONTENT'
};

const DRY_RUN = process.argv.includes('--dry-run');

// Matches a plain, unauthenticated GitHub HTTPS remote only (https://github.com/<owner>/<repo>[.git]).
// An SSH remote, an already-authenticated https://user:token@... URL, a non-GitHub host, or (in tests)
// a plain filesystem path used as a git remote never matches and is left untouched.
const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

// SECURITY: the return value's `url` may embed PUBLISH_TOKEN and must never be logged. Only `label`
// (at most "<owner>/<repo>", never a full URL) is safe to print. Every caller that logs "what remote"
// must use `label`, never `remote` or `url`.
function resolveRemote(remote) {
  const match = GITHUB_HTTPS_RE.exec(remote);
  if (!match) return { url: remote, label: undefined };
  const [, owner, repo] = match;
  const label = `${owner}/${repo}`;
  if (!PUBLISH_TOKEN) return { url: remote, label };
  return { url: `https://x-access-token:${PUBLISH_TOKEN}@github.com/${owner}/${repo}.git`, label };
}

// Strips PUBLISH_TOKEN (and, defensively, any x-access-token credential shape) out of an error
// message before it is ever logged. execFileSync's own error message includes the full command line
// it ran, and git's own stderr on a failed clone/fetch/push echoes the remote URL back - both are
// therefore sanitized here regardless of whether PUBLISH_TOKEN happens to appear literally.
function sanitizeGitError(message) {
  let sanitized = message;
  if (PUBLISH_TOKEN) sanitized = sanitized.split(PUBLISH_TOKEN).join('***');
  sanitized = sanitized.replace(/x-access-token:[^@]*@/g, 'x-access-token:***@');
  return sanitized;
}

// execFileSync wrapper for every git invocation that may touch an authenticated remote URL.
//
// SECURITY: `stdio` is always forced to ['ignore', 'pipe', 'pipe'], overriding any caller-supplied
// value, never merged with it. Node's execFileSync defaults `inheritStderr` to `!options.stdio`,
// meaning that without an explicit `stdio` option it writes git's raw, unsanitized stderr straight
// to this process's own real stderr - e.g. the CI log - *inside* execFileSync itself, before this
// try/catch even runs. Forcing `stdio: 'pipe'` is the only way to stop that: it makes execFileSync
// capture stderr into `err.stderr` instead of inheriting it, so nothing reaches the real stderr
// unless this wrapper's caller explicitly logs it - and any caller that does so is required to pass
// it through `sanitizeGitError` first (see call sites below; none currently print raw stdout/stderr).
//
// On failure, `err.message` (which execFileSync builds from the command line and stderr) is
// sanitized before it propagates, and `err.stderr`/`err.stdout` (Buffers or strings, depending on
// `opts.encoding`) are also sanitized in place so any caller that inspects them later never sees a
// raw token either.
function git(args, opts) {
  const finalOpts = { ...opts, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    return execFileSync('git', args, finalOpts);
  } catch (err) {
    err.message = sanitizeGitError(err.message);
    if (typeof err.stderr === 'string') err.stderr = sanitizeGitError(err.stderr);
    else if (Buffer.isBuffer(err.stderr)) err.stderr = Buffer.from(sanitizeGitError(err.stderr.toString('utf8')));
    if (typeof err.stdout === 'string') err.stdout = sanitizeGitError(err.stdout);
    else if (Buffer.isBuffer(err.stdout)) err.stdout = Buffer.from(sanitizeGitError(err.stdout.toString('utf8')));
    throw err;
  }
}

// The short name of every branch the remote already has, in `git ls-remote --heads` order.
function remoteHeads(remote) {
  const output = git(['ls-remote', '--heads', remote], { encoding: 'utf8' }).trim();
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.split('\trefs/heads/')[1])
    .filter(Boolean);
}

// The set of tag names the remote already has (lightweight tags only are ever created here, so the
// `^{}` dereferenced-annotated-tag suffix is stripped defensively rather than expected).
function remoteTags(remote) {
  const output = git(['ls-remote', '--tags', remote], { encoding: 'utf8' }).trim();
  if (!output) return new Set();
  const tags = output
    .split('\n')
    .map((line) => line.split('\trefs/tags/')[1])
    .filter(Boolean)
    .map((name) => name.replace(/\^\{\}$/, ''));
  return new Set(tags);
}

// Clones (or, for a genuinely empty repository, initializes) the variant's working directory and
// returns the branch name in use. `remote` here is already the resolved (possibly authenticated) URL.
function prepareWorkingDir(remote, dir) {
  // The variant subdirectory may be left over from an earlier run against the same PUBLISH_WORK_DIR
  // (an explicit env override is a plain working directory, not guaranteed fresh per run). Every run
  // clones the remote's current state from scratch, so any stale clone is simply discarded first.
  fs.rmSync(dir, { recursive: true, force: true });
  const heads = remoteHeads(remote);
  if (heads.length === 0) {
    git(['init', '--quiet', `--initial-branch=${DEFAULT_BRANCH}`, dir]);
    git(['remote', 'add', 'origin', remote], { cwd: dir });
    // The remote has no refs at all yet; this fetch is a documented no-op kept for parity with the
    // plan's algorithm (step 1) rather than for any effect.
    git(['fetch', '--quiet', 'origin'], { cwd: dir });
    return DEFAULT_BRANCH;
  }
  const branch = heads[0];
  git(['clone', '--quiet', '--branch', branch, remote, dir]);
  return branch;
}

function commitVersion(dir, variant, version, entry) {
  const composerJson = serializeTagComposerJson(buildTagComposerJson(variant, entry));
  fs.writeFileSync(path.join(dir, 'composer.json'), composerJson);
  git(['add', 'composer.json'], { cwd: dir });
  git(
    ['-c', 'user.name=GitHub Actions', '-c', 'user.email=actions@github.com', 'commit', '--quiet', '-m', version],
    { cwd: dir }
  );
  git(['tag', version], { cwd: dir });
}

// Publishes one variant. Returns nothing; all outcomes are reported via console.log per contract C4.
// SECURITY: `remote` (the raw env var value) and `gitRemote` (possibly with an embedded token) must
// never be logged; only `label` (owner/repo, or undefined when unparseable) is safe to print.
function publishVariant(variant, versions, workDir) {
  const envVar = REMOTE_ENV_VAR[variant.name];
  const remote = process.env[envVar];
  if (!remote) {
    console.log(`SKIPPED-NO-REMOTE: ${variant.name}`);
    return;
  }

  const { url: gitRemote, label } = resolveRemote(remote);

  const dir = path.join(workDir, variant.name.split('/')[1]);
  const branch = prepareWorkingDir(gitRemote, dir);
  const existingTags = remoteTags(gitRemote);

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
    const destination = label ? ` (${label})` : '';
    console.log(`DRY-RUN: would push ${created} new tag(s) and branch ${branch} for ${variant.name}${destination}`);
    return;
  }

  git(['push', '--quiet', gitRemote, `HEAD:${branch}`], { cwd: dir });
  git(['push', '--quiet', gitRemote, '--tags'], { cwd: dir });
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

module.exports = {
  main,
  publishVariant,
  prepareWorkingDir,
  remoteHeads,
  remoteTags,
  resolveRemote,
  sanitizeGitError,
  runGit: git
};
