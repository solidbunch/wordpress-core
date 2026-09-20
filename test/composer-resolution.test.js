'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');

const { startServer, withTempDir } = require('./helpers');
const { buildTagComposerJson } = require('../lib/tag-composer');
const { readPackagesFile } = require('../lib/packages-file');
const { VARIANTS } = require('../lib/constants');

const execFileAsync = promisify(execFile);

const PACKAGES_FILE = path.join(__dirname, '..', 'packages.json');
const packages = readPackagesFile(PACKAGES_FILE, { required: true });

const [noContent, full] = VARIANTS;

function pickEntry(variantName) {
  const versions = packages[variantName];
  const key = Object.keys(versions)[0];
  return { version: key, entry: versions[key] };
}

const cases = [
  { variant: full, ...pickEntry(full.name) },
  { variant: noContent, ...pickEntry(noContent.name) }
];

// Detects a usable `composer` binary once, at module load. Composer resolution requires a
// working `php` binary too, but a Composer that shells out to a broken/missing php fails the
// same `--version` probe used here, so a single check covers both.
function detectComposer() {
  try {
    execFileSync('composer', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const hasComposer = detectComposer();

function skipNoComposer(t) {
  const reason = 'composer is not installed; the tag composer.json resolution check did not run';
  t.skip(reason);
  console.log(`SKIPPED-NO-COMPOSER: ${reason}`);
}

// Recursively checks that no value in a plain-data object/array is null or an empty string.
// Composer-required manifest fields must all be present with real content, not placeholders.
function assertNoNullOrEmptyString(value, pathLabel) {
  if (value === null) {
    assert.fail(`${pathLabel} is null`);
  }
  if (value === '') {
    assert.fail(`${pathLabel} is an empty string`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNullOrEmptyString(item, `${pathLabel}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      assertNoNullOrEmptyString(nested, `${pathLabel}.${key}`);
    }
  }
}

// Pure-Node assertion, always runs regardless of whether Composer is installed: the tag
// manifest built for each variant carries every key Composer requires for a `composer`-type
// repository entry, and none of its values are null or an empty string.
for (const { variant, version, entry } of cases) {
  test(`buildTagComposerJson(${variant.name}) has every key Composer requires and no null/empty values`, () => {
    const manifest = buildTagComposerJson(variant, entry);

    assert.equal(typeof manifest.name, 'string');
    assert.ok(manifest.name.length > 0);
    assert.equal(typeof manifest.version, 'string');
    assert.ok(manifest.version.length > 0);
    assert.equal(typeof manifest.type, 'string');
    assert.ok(manifest.type.length > 0);
    assert.ok(manifest.dist && typeof manifest.dist === 'object');
    assert.equal(typeof manifest.dist.type, 'string');
    assert.ok(manifest.dist.type.length > 0);
    assert.equal(typeof manifest.dist.url, 'string');
    assert.ok(manifest.dist.url.length > 0);

    assertNoNullOrEmptyString(manifest, `${variant.name}@${version}`);
  });
}

// Builds a minimal Composer project that resolves solidbunch/wordpress-core exclusively against
// a local HTTP fixture server serving the tag composer.json entry through a "composer"-type
// repository, with packagist.org disabled. `--no-install` keeps this offline and fast: Composer
// resolves and locks the package without downloading its dist archive.
async function runOfflineResolution({ variant, version, entry }) {
  return withTempDir(async (projectDir) =>
    withTempDir(async (composerHome) => {
      const manifest = buildTagComposerJson(variant, entry);
      let servedDistUrl;

      const { url: serverUrl, close } = await startServer({
        '/packages.json': (req, res) => {
          const served = JSON.parse(JSON.stringify(manifest));
          served.dist.url = `${serverUrl}/dist/${path.basename(manifest.dist.url)}`;
          servedDistUrl = served.dist.url;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              packages: {
                [manifest.name]: {
                  [manifest.version]: served
                }
              }
            })
          );
        }
      });

      try {
        const composerJson = {
          repositories: [{ type: 'composer', url: serverUrl }, { 'packagist.org': false }],
          require: { [manifest.name]: version },
          config: { platform: { php: '8.3.0' } },
          'minimum-stability': 'stable'
        };
        fs.writeFileSync(path.join(projectDir, 'composer.json'), JSON.stringify(composerJson, null, 2));

        await execFileAsync('composer', ['update', '--no-install', '--no-interaction', '--no-progress'], {
          cwd: projectDir,
          env: { ...process.env, COMPOSER_HOME: composerHome }
        });

        const lock = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.lock'), 'utf8'));
        const lockedPackage = lock.packages.find((pkg) => pkg.name === manifest.name);
        assert.ok(lockedPackage, `${manifest.name} is missing from composer.lock`);
        return { lockedPackage, manifest, servedDistUrl };
      } finally {
        await close();
      }
    })
  );
}

for (const { variant, version, entry } of cases) {
  test(`composer update --no-install resolves the tag composer.json for ${variant.name}@${version}`, async (t) => {
    if (!hasComposer) {
      skipNoComposer(t);
      return;
    }

    const { lockedPackage, manifest, servedDistUrl } = await runOfflineResolution({ variant, version, entry });

    assert.equal(lockedPackage.name, manifest.name);
    assert.equal(lockedPackage.version, '7.1.1');
    assert.equal(lockedPackage.dist.url, servedDistUrl);
    assert.equal(lockedPackage.dist.shasum, manifest.dist.shasum);
    assert.equal(lockedPackage.type, 'wordpress-core');
    assert.equal(lockedPackage.provide['wordpress/core-implementation'], '7.1.1');

    if (variant.hasSource) {
      assert.ok(lockedPackage.source, `${manifest.name} should keep its source key`);
    } else {
      assert.equal(lockedPackage.source, undefined, `${manifest.name} must not gain a source from the manifest`);
    }
  });
}
