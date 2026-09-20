'use strict';

// Offline end-to-end tests for T3.3 (plan backlog 3.3): per-variant prerelease publication.
//
// generate()'s archive/version.php URLs are built from the canonical, non-overridable DOWNLOAD_BASE
// and VERSION_PHP_URLS hosts (downloads.wordpress.org, core.svn.wordpress.org,
// raw.githubusercontent.com) - unlike API_URL/STABLE_CHECK_URL, which already have an env-var test
// seam (see test/generator-offers.test.js). To stay fully offline while still exercising the real
// generate()/resolveNew/resolveVersion code paths, these tests run a single local HTTP server (via
// test/helpers.js' startServer, the same real-server pattern used throughout the suite) and
// temporarily rewrite global.fetch so that requests to those three hostnames are redirected to it,
// with every other request (in particular the local server used for API_URL_OVERRIDE /
// STABLE_CHECK_URL_OVERRIDE) going through unchanged. Nothing here ever reaches a non-loopback host.
//
// PACKAGES_FILE is a fixed relative constant, not env-overridable (see test/backfill.test.js), so
// each test chdir()s into its own temp directory before calling generate()/check() directly (in
// process, not as a child process) and restores the original cwd afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');

const { generate, check } = require('../generate-packages-json');
const { VARIANTS } = require('../lib/constants');
const { startServer, withTempDir } = require('./helpers');

const [noContent, full] = VARIANTS;

const REDIRECTED_HOSTS = new Set(['downloads.wordpress.org', 'core.svn.wordpress.org', 'raw.githubusercontent.com']);

// Rewrites requests to the canonical WordPress.org/GitHub hosts to the given local server, keeping
// path and query intact, and passes everything else (e.g. the API_URL_OVERRIDE/STABLE_CHECK_URL_OVERRIDE
// server) straight through to the real fetch.
function withRedirectedHosts(serverUrl, fn) {
  const original = global.fetch;
  const target = new URL(serverUrl);
  global.fetch = (input, init) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url);
    if (REDIRECTED_HOSTS.has(requestUrl.hostname)) {
      requestUrl.protocol = target.protocol;
      requestUrl.hostname = target.hostname;
      requestUrl.port = target.port;
      return original(requestUrl.href, init);
    }
    return original(input, init);
  };
  return (async () => {
    try {
      return await fn();
    } finally {
      global.fetch = original;
    }
  })();
}

async function withCwd(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  return (async () => {
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines;
  })();
}

const SHASUM = 'a'.repeat(40);
const BASE_VERSION = '6.9'; // pre-existing stable version, kept via resolveExisting without any network I/O

// A minimal, valid packages.json with one already-existing stable version for both variants, so the
// per-variant "package must not be empty" invariant never fires regardless of what happens to the
// version under test.
function seedPackages() {
  const entryFor = (variant) => ({
    name: variant.name,
    version: BASE_VERSION,
    type: 'wordpress-core',
    license: 'GPL-2.0-or-later',
    require: { php: '>=7.4' },
    dist: { type: 'zip', url: `https://downloads.wordpress.org/release/wordpress-${BASE_VERSION}${variant.suffix}.zip`, shasum: SHASUM },
    extra: { mysql_version: '5.5.5' }
  });
  return {
    [noContent.name]: { [BASE_VERSION]: entryFor(noContent) },
    [full.name]: { [BASE_VERSION]: entryFor(full) }
  };
}

function writePackages(dir, packages) {
  fs.writeFileSync(path.join(dir, 'packages.json'), `${JSON.stringify({ packages }, null, 2)}\n`);
}

function jsonRoute(status, body) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

function textRoute(status, body) {
  return (req, res) => {
    res.writeHead(status);
    res.end(body);
  };
}

function apiServer({ offers, stableCheck }) {
  return startServer({
    '/version-check': jsonRoute(200, { offers }),
    '/stable-check': jsonRoute(200, stableCheck)
  });
}

// Runs generate() and reads back the GITHUB_OUTPUT file it appends to, mirroring exactly what the
// real pipeline does: generate() itself never fails because of deferred versions (it only reports
// them via the "incomplete" output), and it is update-packages.yml's separate "Fail if the run was
// incomplete" step that turns a nonzero `incomplete` count into a failed run (see that workflow and
// generate-packages-json.js's own GITHUB_OUTPUT append). Reproducing that gate here is what makes
// "exit 0"/"exit 1" in the plan's acceptance criteria for this task observable in a single call.
async function runGenerate(dir) {
  const githubOutput = path.join(dir, 'github_output.txt');
  fs.writeFileSync(githubOutput, '');
  const logs = await withEnv({ GITHUB_OUTPUT: githubOutput }, () => captureLog(() => generate()));
  const output = fs.readFileSync(githubOutput, 'utf8');
  const incomplete = Number((/^incomplete=(\d+)$/m.exec(output) || [])[1] ?? 0);
  return { logs, incomplete, exitCode: incomplete > 0 ? 1 : 0 };
}

async function runCheck() {
  try {
    const logs = await captureLog(() => check());
    return { exitCode: 0, logs };
  } catch (err) {
    return { exitCode: 1, error: err.message };
  }
}

function sha1Hex(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

test('prerelease: full variant added, no-content skipped (not deferred), ASYMMETRIC-PRERELEASE reported, --check passes', async () => {
  await withTempDir(async (dir) => {
    writePackages(dir, seedPackages());
    const version = '7.2-RC1';
    const archive = Buffer.from('fake full wordpress archive for 7.2-RC1');
    const archiveSha1 = sha1Hex(archive);

    const { url: apiUrl, close: closeApi } = await apiServer({
      offers: [{ version, php_version: '8.1.0', mysql_version: '5.5.5' }],
      stableCheck: { [BASE_VERSION]: 'outdated' }
    });
    const { url: hostsUrl, close: closeHosts } = await startServer({
      [`/release/wordpress-${version}.zip`]: (req, res) => {
        res.writeHead(200);
        res.end(archive);
      },
      [`/release/wordpress-${version}.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end(archiveSha1);
      }
      // no route for the no-content .sha1: startServer answers 404, exercising SKIPPED-NO-ARCHIVE
      // no route for .md5 either: exercises the noMd5 path, irrelevant to this test's assertions
    });

    try {
      const result = await withEnv({ API_URL_OVERRIDE: `${apiUrl}/version-check`, STABLE_CHECK_URL_OVERRIDE: `${apiUrl}/stable-check` }, () =>
        withRedirectedHosts(hostsUrl, () => withCwd(dir, () => runGenerate(dir)))
      );

      assert.equal(result.exitCode, 0, result.logs.join('\n'));
      assert.equal(result.incomplete, 0);
      // The reason text embeds the *canonical* URL (distUrl always uses DOWNLOAD_BASE), even though
      // the actual network request was transparently redirected to the local server above.
      assert.ok(
        result.logs.some((line) => line === `SKIPPED-NO-ARCHIVE: ${noContent.name} ${version}: https://downloads.wordpress.org/release/wordpress-${version}-no-content.zip.sha1 returned 404`),
        result.logs.join('\n')
      );
      assert.ok(
        result.logs.some((line) => line === `ASYMMETRIC-PRERELEASE: ${version} exists only in ${full.name} (expected: wordpress.org may not publish a ${noContent.suffix} archive for pre-releases)`),
        result.logs.join('\n')
      );
      assert.ok(!result.logs.some((line) => line.startsWith('DEFERRED:')), result.logs.join('\n'));

      const written = JSON.parse(fs.readFileSync(path.join(dir, 'packages.json'), 'utf8')).packages;
      assert.equal(Object.hasOwn(written[full.name], version), true);
      assert.equal(Object.hasOwn(written[noContent.name], version), false);

      const checkResult = await withCwd(dir, () => runCheck());
      assert.equal(checkResult.exitCode, 0, checkResult.error);
      assert.ok(checkResult.logs.some((line) => line.startsWith('ASYMMETRIC-PRERELEASE:')), checkResult.logs.join('\n'));
    } finally {
      await closeApi();
      await closeHosts();
    }
  });
});

test('prerelease: both version.php sources 404 -> SKIPPED-NO-METADATA, exit 0, incomplete=0', async () => {
  await withTempDir(async (dir) => {
    writePackages(dir, seedPackages());
    const version = '7.2-RC1';

    const fullArchive = Buffer.from('fake full wordpress archive for 7.2-RC1 (no metadata)');
    const noContentArchive = Buffer.from('fake no-content wordpress archive for 7.2-RC1 (no metadata)');

    const { url: apiUrl, close: closeApi } = await apiServer({
      // No php_version offered: forces metadataFromOffer() to fail and version.php to be consulted.
      offers: [{ version }],
      stableCheck: { [BASE_VERSION]: 'outdated' }
    });
    const { url: hostsUrl, close: closeHosts } = await startServer({
      [`/release/wordpress-${version}.zip`]: (req, res) => {
        res.writeHead(200);
        res.end(fullArchive);
      },
      [`/release/wordpress-${version}.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end(sha1Hex(fullArchive));
      },
      [`/release/wordpress-${version}-no-content.zip`]: (req, res) => {
        res.writeHead(200);
        res.end(noContentArchive);
      },
      [`/release/wordpress-${version}-no-content.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end(sha1Hex(noContentArchive));
      }
      // no routes for /tags/.../version.php or /WordPress/WordPress/.../version.php: both 404
    });

    try {
      const result = await withEnv({ API_URL_OVERRIDE: `${apiUrl}/version-check`, STABLE_CHECK_URL_OVERRIDE: `${apiUrl}/stable-check` }, () =>
        withRedirectedHosts(hostsUrl, () => withCwd(dir, () => runGenerate(dir)))
      );

      assert.equal(result.exitCode, 0, result.logs.join('\n'));
      assert.equal(result.incomplete, 0);
      assert.ok(!result.logs.some((line) => line.startsWith('DEFERRED:')), result.logs.join('\n'));
      assert.ok(result.logs.some((line) => line.includes(`${full.name} ${version}: SKIPPED-NO-METADATA`)), result.logs.join('\n'));
      assert.ok(result.logs.some((line) => line.includes(`${noContent.name} ${version}: SKIPPED-NO-METADATA`)), result.logs.join('\n'));

      const written = JSON.parse(fs.readFileSync(path.join(dir, 'packages.json'), 'utf8')).packages;
      assert.equal(Object.hasOwn(written[full.name], version), false);
      assert.equal(Object.hasOwn(written[noContent.name], version), false);
    } finally {
      await closeApi();
      await closeHosts();
    }
  });
});

test('stable version, same both-version.php-404 metadata failure -> still deferred, incomplete=1, exit 1 (proves the stable path is untouched)', async () => {
  await withTempDir(async (dir) => {
    writePackages(dir, seedPackages());
    const version = '9.9'; // stable, new (not in the seeded packages.json)

    const fullArchive = Buffer.from('fake full wordpress archive for 9.9');
    const noContentArchive = Buffer.from('fake no-content wordpress archive for 9.9');

    const { url: apiUrl, close: closeApi } = await apiServer({
      offers: [],
      stableCheck: { [BASE_VERSION]: 'outdated', [version]: 'latest' }
    });
    const { url: hostsUrl, close: closeHosts } = await startServer({
      [`/release/wordpress-${version}.zip`]: (req, res) => {
        res.writeHead(200);
        res.end(fullArchive);
      },
      [`/release/wordpress-${version}.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end(sha1Hex(fullArchive));
      },
      [`/release/wordpress-${version}-no-content.zip`]: (req, res) => {
        res.writeHead(200);
        res.end(noContentArchive);
      },
      [`/release/wordpress-${version}-no-content.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end(sha1Hex(noContentArchive));
      }
      // no routes for version.php on either host: both 404, same failure as the prerelease test above
    });

    try {
      const result = await withEnv({ API_URL_OVERRIDE: `${apiUrl}/version-check`, STABLE_CHECK_URL_OVERRIDE: `${apiUrl}/stable-check` }, () =>
        withRedirectedHosts(hostsUrl, () => withCwd(dir, () => runGenerate(dir)))
      );

      assert.equal(result.incomplete, 1, result.logs.join('\n'));
      assert.equal(result.exitCode, 1);
      assert.ok(result.logs.some((line) => line === 'INCOMPLETE: 1 version(s) deferred'), result.logs.join('\n'));
      assert.ok(result.logs.some((line) => line.includes(`DEFERRED: ${full.name} ${version}:`)), result.logs.join('\n'));
      assert.ok(result.logs.some((line) => line.includes(`DEFERRED: ${noContent.name} ${version}:`)), result.logs.join('\n'));
      assert.ok(!result.logs.some((line) => line.includes('SKIPPED-NO-METADATA')), result.logs.join('\n'));

      const written = JSON.parse(fs.readFileSync(path.join(dir, 'packages.json'), 'utf8')).packages;
      assert.equal(Object.hasOwn(written[full.name], version), false);
      assert.equal(Object.hasOwn(written[noContent.name], version), false);
    } finally {
      await closeApi();
      await closeHosts();
    }
  });
});

test('prerelease: a transient 500 on the full variant\'s archive defers both variants (pairing intact)', { timeout: 20000 }, async () => {
  await withTempDir(async (dir) => {
    writePackages(dir, seedPackages());
    const version = '7.2-RC1';
    const noContentArchive = Buffer.from('fake no-content wordpress archive for 7.2-RC1 (transient)');

    const { url: apiUrl, close: closeApi } = await apiServer({
      offers: [{ version, php_version: '8.1.0' }],
      stableCheck: { [BASE_VERSION]: 'outdated' }
    });
    const { url: hostsUrl, close: closeHosts } = await startServer({
      [`/release/wordpress-${version}.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end('b'.repeat(40));
      },
      [`/release/wordpress-${version}.zip`]: (req, res) => {
        res.writeHead(500);
        res.end('boom');
      },
      [`/release/wordpress-${version}-no-content.zip.sha1`]: (req, res) => {
        res.writeHead(200);
        res.end(sha1Hex(noContentArchive));
      },
      [`/release/wordpress-${version}-no-content.zip`]: (req, res) => {
        res.writeHead(200);
        res.end(noContentArchive);
      }
    });

    try {
      const result = await withEnv({ API_URL_OVERRIDE: `${apiUrl}/version-check`, STABLE_CHECK_URL_OVERRIDE: `${apiUrl}/stable-check` }, () =>
        withRedirectedHosts(hostsUrl, () => withCwd(dir, () => runGenerate(dir)))
      );

      assert.equal(result.incomplete, 1, result.logs.join('\n'));
      assert.equal(result.exitCode, 1);
      assert.ok(result.logs.some((line) => line.includes(`DEFERRED: ${full.name} ${version}:`)), result.logs.join('\n'));
      assert.ok(result.logs.some((line) => line.includes(`DEFERRED: ${noContent.name} ${version}: paired with a deferred variant`)), result.logs.join('\n'));

      const written = JSON.parse(fs.readFileSync(path.join(dir, 'packages.json'), 'utf8')).packages;
      assert.equal(Object.hasOwn(written[full.name], version), false);
      assert.equal(Object.hasOwn(written[noContent.name], version), false);
    } finally {
      await closeApi();
      await closeHosts();
    }
  });
});
