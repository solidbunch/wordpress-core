'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { startServer, withTempDir } = require('./helpers');

const execFileAsync = promisify(execFile);
const AUDIT_SCRIPT = path.join(__dirname, '..', 'audit-checksums.js');

const SHASUM_A = 'a'.repeat(40);
const SHASUM_B = 'b'.repeat(40);

// A minimal two-entry fixture: one version in each variant, each with its own shasum so a
// mismatch on one route never accidentally matches the other entry's stored value.
function twoEntryPackages() {
  return {
    'solidbunch/wordpress-core-no-content': {
      '6.9': { dist: { type: 'zip', url: 'https://downloads.wordpress.org/release/wordpress-6.9-no-content.zip', shasum: SHASUM_A } }
    },
    'solidbunch/wordpress-core': {
      '6.8': { dist: { type: 'zip', url: 'https://downloads.wordpress.org/release/wordpress-6.8.zip', shasum: SHASUM_B } }
    }
  };
}

// Twenty entries, all in the same variant, all sharing one stored shasum, so the caller can make
// exactly one of the twenty routes unreachable while every other route serves that shasum back.
function twentyEntryPackages() {
  const entries = {};
  for (let i = 1; i <= 20; i++) {
    entries[`6.${i}`] = { dist: { type: 'zip', url: `https://downloads.wordpress.org/release/wordpress-6.${i}-no-content.zip`, shasum: SHASUM_A } };
  }
  return {
    'solidbunch/wordpress-core-no-content': entries,
    'solidbunch/wordpress-core': {}
  };
}

function writePackages(dir, packages) {
  const file = path.join(dir, 'packages.json');
  fs.writeFileSync(file, JSON.stringify({ packages }, null, 2));
  return file;
}

// Runs audit-checksums.js as a child process; never throws on non-zero exit, callers assert
// exitCode/stdout/stderr explicitly.
async function runAudit(env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [AUDIT_SCRIPT], { env });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function sha1Route(shasum) {
  return (req, res) => {
    res.writeHead(200);
    res.end(shasum);
  };
}

test('every stored shasum matches the published one -> exit 0', async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/release/wordpress-6.9-no-content.zip.sha1': sha1Route(SHASUM_A),
      '/release/wordpress-6.8.zip.sha1': sha1Route(SHASUM_B)
    });
    try {
      const packagesFile = writePackages(dir, twoEntryPackages());
      const before = fs.readFileSync(packagesFile);
      const result = await runAudit({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /AUDITED 2 entries: 0 mismatches, 0 missing, 0 unreachable/);
      assert.deepEqual(fs.readFileSync(packagesFile), before);
    } finally {
      await close();
    }
  });
});

test('one mismatch -> exit 1 and a MISMATCH: line naming both values', async () => {
  await withTempDir(async (dir) => {
    const publishedForB = 'd'.repeat(40);
    const { url, close } = await startServer({
      '/release/wordpress-6.9-no-content.zip.sha1': sha1Route(SHASUM_A),
      '/release/wordpress-6.8.zip.sha1': sha1Route(publishedForB)
    });
    try {
      const packagesFile = writePackages(dir, twoEntryPackages());
      const before = fs.readFileSync(packagesFile);
      const result = await runAudit({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, new RegExp(`MISMATCH: solidbunch/wordpress-core 6\\.8: stored ${SHASUM_B}, published ${publishedForB}`));
      assert.match(result.stdout, /AUDITED 2 entries: 1 mismatch, 0 missing, 0 unreachable/);
      assert.deepEqual(fs.readFileSync(packagesFile), before);
    } finally {
      await close();
    }
  });
});

test('.sha1 404 (missing archive) -> exit 1 with MISSING:', async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/release/wordpress-6.9-no-content.zip.sha1': sha1Route(SHASUM_A)
      // no route for 6.8's .sha1: startServer answers 404 by default
    });
    try {
      const packagesFile = writePackages(dir, twoEntryPackages());
      const before = fs.readFileSync(packagesFile);
      const result = await runAudit({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /MISSING: solidbunch\/wordpress-core 6\.8: .*wordpress-6\.8\.zip\.sha1 returned 404/);
      assert.deepEqual(fs.readFileSync(packagesFile), before);
    } finally {
      await close();
    }
  });
});

test('every route unreachable -> exit 1 with AUDIT-INCONCLUSIVE', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/release/wordpress-6.9-no-content.zip.sha1': (req, res) => {
        res.writeHead(500);
        res.end('boom');
      },
      '/release/wordpress-6.8.zip.sha1': (req, res) => {
        res.writeHead(500);
        res.end('boom');
      }
    });
    try {
      const packagesFile = writePackages(dir, twoEntryPackages());
      const before = fs.readFileSync(packagesFile);
      const result = await runAudit({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /AUDIT-INCONCLUSIVE: 2 of 2 entries unreachable/);
      assert.match(result.stdout, /AUDITED 2 entries: 0 mismatches, 0 missing, 2 unreachable/);
      assert.deepEqual(fs.readFileSync(packagesFile), before);
    } finally {
      await close();
    }
  });
});

test('one unreachable entry out of twenty -> exit 0 with a warning', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const routes = {};
    for (let i = 1; i <= 20; i++) {
      routes[`/release/wordpress-6.${i}-no-content.zip.sha1`] =
        i === 13
          ? (req, res) => {
              res.writeHead(500);
              res.end('boom');
            }
          : sha1Route(SHASUM_A);
    }
    const { url, close } = await startServer(routes);
    try {
      const packagesFile = writePackages(dir, twentyEntryPackages());
      const before = fs.readFileSync(packagesFile);
      const result = await runAudit({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /WARNING: 1 entry is unreachable/);
      assert.match(result.stdout, /AUDITED 20 entries: 0 mismatches, 0 missing, 1 unreachable/);
      assert.deepEqual(fs.readFileSync(packagesFile), before);
    } finally {
      await close();
    }
  });
});
