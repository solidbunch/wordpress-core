'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { startServer, withTempDir } = require('./helpers');

const execFileAsync = promisify(execFile);
const GATE_SCRIPT = path.join(__dirname, '..', 'check-new-versions.js');

function writePackages(dir, packages) {
  const file = path.join(dir, 'packages.json');
  fs.writeFileSync(file, JSON.stringify({ packages }, null, 2));
  return file;
}

// Runs check-new-versions.js as a child process; never throws on non-zero exit,
// callers assert exitCode/stdout/stderr explicitly.
async function runGate(env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [GATE_SCRIPT], { env });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function readOutput(outputFile) {
  return fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
}

test('all offered versions already present -> run=false', async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ offers: [{ version: '6.9' }] }));
      }
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': { '6.9': {} }
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /All 1 offered version\(s\) are in/);
      assert.equal(readOutput(outputFile), 'run=false\n');
    } finally {
      await close();
    }
  });
});

test('a missing version whose archive exists -> run=true', async () => {
  await withTempDir(async (dir) => {
    const shasum = '0'.repeat(40);
    const { url, close } = await startServer({
      '/version-check': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ offers: [{ version: '6.9' }] }));
      },
      '/release/wordpress-6.9.zip.sha1': (req, res) => {
        res.writeHead(200);
        res.end(shasum);
      }
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': {}
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /solidbunch\/wordpress-core 6\.9 is offered, missing and its archive exists/);
      assert.equal(readOutput(outputFile), 'run=true\n');
    } finally {
      await close();
    }
  });
});

test('a missing version whose archive does not exist -> run=false, SKIPPED-NO-ARCHIVE', async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ offers: [{ version: '6.9' }] }));
      }
      // no route for the .sha1 probe: startServer answers 404 by default
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': {}
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /SKIPPED-NO-ARCHIVE: solidbunch\/wordpress-core 6\.9: .*wordpress-6\.9\.zip\.sha1 returned 404/);
      assert.match(result.stdout, /1 offered package version\(s\) have no archive yet/);
      assert.equal(readOutput(outputFile), 'run=false\n');
    } finally {
      await close();
    }
  });
});

test('FORCE_FULL=true -> run=true without any HTTP request', async () => {
  await withTempDir(async (dir) => {
    let requestCount = 0;
    const { url, close } = await startServer({
      '/version-check': (req, res) => {
        requestCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ offers: [{ version: '6.9' }] }));
      }
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': {},
        'solidbunch/wordpress-core': {}
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        FORCE_FULL: 'true',
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /FORCE_FULL=true: skipping the release check/);
      assert.equal(readOutput(outputFile), 'run=true\n');
      assert.equal(requestCount, 0);
    } finally {
      await close();
    }
  });
});

test('a non-version offer is ignored, valid offers still resolve', async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ offers: [{ version: '6.9' }, { version: 'not-a-version' }] }));
      }
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': { '6.9': {} }
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /IGNORED-VERSION: "not-a-version" \(from offers\)/);
      assert.equal(readOutput(outputFile), 'run=false\n');
    } finally {
      await close();
    }
  });
});

test('the version-check route failing on every attempt is fatal', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': (req, res) => {
        res.writeHead(500);
        res.end('boom');
      }
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': {},
        'solidbunch/wordpress-core': {}
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, new RegExp(`FATAL: cannot fetch ${url}/version-check: HTTP 500 \\(after 3 attempts\\)`));
      assert.equal(readOutput(outputFile), '');
    } finally {
      await close();
    }
  });
});

// betaChannelUrl() derives the beta URL from the same base with ?channel=beta appended, so a single
// route dispatches on the query param the same way the stable/beta requests differ in the client.
function versionCheckRoute({ stable, beta }) {
  return (req, res, url) => {
    const handler = url.searchParams.get('channel') === 'beta' ? beta : stable;
    handler(req, res, url);
  };
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

test('beta channel offers a version not offered by stable -> merged, run=true', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const shasum = '0'.repeat(40);
    const { url, close } = await startServer({
      '/version-check': versionCheckRoute({
        stable: jsonRoute(200, { offers: [{ version: '6.9' }] }),
        beta: jsonRoute(200, { offers: [{ version: '7.0-RC1' }] })
      }),
      '/release/wordpress-6.9.zip.sha1': textRoute(404, 'not found'),
      '/release/wordpress-6.9-no-content.zip.sha1': textRoute(404, 'not found'),
      '/release/wordpress-7.0-RC1.zip.sha1': (req, res) => {
        res.writeHead(200);
        res.end(shasum);
      },
      '/release/wordpress-7.0-RC1-no-content.zip.sha1': (req, res) => {
        res.writeHead(200);
        res.end(shasum);
      }
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': { '6.9': {} }
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        DOWNLOAD_BASE_OVERRIDE: `${url}/release/`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /7\.0-RC1 is offered, missing and its archive exists/);
      assert.equal(readOutput(outputFile), 'run=true\n');
    } finally {
      await close();
    }
  });
});

test('beta channel 500 -> BETA-CHANNEL-UNAVAILABLE logged, stable offers still used', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': versionCheckRoute({
        stable: jsonRoute(200, { offers: [{ version: '6.9' }] }),
        beta: textRoute(500, 'boom')
      })
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': { '6.9': {} }
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`BETA-CHANNEL-UNAVAILABLE: cannot fetch ${url}/version-check\\?channel=beta: HTTP 500`));
      assert.match(result.stdout, /All 1 offered version\(s\) are in/);
      assert.equal(readOutput(outputFile), 'run=false\n');
    } finally {
      await close();
    }
  });
});

test('beta channel returns an unparseable body -> BETA-CHANNEL-UNAVAILABLE logged, stable offers still used', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': versionCheckRoute({
        stable: jsonRoute(200, { offers: [{ version: '6.9' }] }),
        beta: textRoute(200, 'not json')
      })
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': { '6.9': {} }
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`BETA-CHANNEL-UNAVAILABLE: cannot parse response of ${url}/version-check\\?channel=beta`));
      assert.match(result.stdout, /All 1 offered version\(s\) are in/);
      assert.equal(readOutput(outputFile), 'run=false\n');
    } finally {
      await close();
    }
  });
});

test('beta channel returns {"offers":"nonsense"} -> BETA-CHANNEL-UNAVAILABLE logged, stable offers still used', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const { url, close } = await startServer({
      '/version-check': versionCheckRoute({
        stable: jsonRoute(200, { offers: [{ version: '6.9' }] }),
        beta: jsonRoute(200, { offers: 'nonsense' })
      })
    });
    try {
      const packagesFile = writePackages(dir, {
        'solidbunch/wordpress-core-no-content': { '6.9': {} },
        'solidbunch/wordpress-core': { '6.9': {} }
      });
      const outputFile = path.join(dir, 'github-output');
      const result = await runGate({
        ...process.env,
        PACKAGES_FILE: packagesFile,
        VERSION_CHECK_URL: `${url}/version-check`,
        GITHUB_OUTPUT: outputFile
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`BETA-CHANNEL-UNAVAILABLE: ${url}/version-check\\?channel=beta returned no "offers" array`));
      assert.match(result.stdout, /All 1 offered version\(s\) are in/);
      assert.equal(readOutput(outputFile), 'run=false\n');
    } finally {
      await close();
    }
  });
});
