'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempDir } = require('./helpers');
const { buildStatus, buildBadges, readPickup, writeStatusFiles, STATUS_FILE, BADGES_DIR } = require('../lib/status');

const NO_CONTENT = 'solidbunch/wordpress-core-no-content';
const FULL = 'solidbunch/wordpress-core';

function entries(versions) {
  const out = {};
  for (const version of versions) out[version] = { version };
  return out;
}

test('buildStatus: latest/latestStable per variant with mixed stable + RC + beta', () => {
  const packages = {
    [NO_CONTENT]: entries(['7.1.0', '7.1.1', '7.1.2']),
    [FULL]: entries(['7.0.0', '7.1.2', '7.2-beta1', '7.2-RC1'])
  };
  const status = buildStatus(packages, null);

  assert.deepEqual(status.packages[NO_CONTENT], { latest: '7.1.2', latestStable: '7.1.2', count: 3 });
  assert.deepEqual(status.packages[FULL], { latest: '7.2-RC1', latestStable: '7.1.2', count: 4 });
});

test('buildStatus: keys are in VARIANTS order (no-content first, then full)', () => {
  const packages = { [FULL]: entries(['7.1.0']), [NO_CONTENT]: entries(['7.1.0']) };
  const status = buildStatus(packages, null);
  assert.deepEqual(Object.keys(status.packages), [NO_CONTENT, FULL]);
});

test('buildStatus: a prerelease below the newest stable -> wordpress.latestPrerelease is null', () => {
  const packages = {
    [NO_CONTENT]: entries(['7.1.2']),
    [FULL]: entries(['7.0-RC1', '7.1.2'])
  };
  const status = buildStatus(packages, null);
  assert.equal(status.wordpress.latestStable, '7.1.2');
  assert.equal(status.wordpress.latestPrerelease, null);
});

test('buildStatus: a prerelease above the newest stable -> reported, but wordpress.json message stays stable', () => {
  const packages = {
    [NO_CONTENT]: entries(['7.1.2']),
    [FULL]: entries(['7.1.2', '7.2-RC1'])
  };
  const status = buildStatus(packages, null);
  assert.equal(status.wordpress.latestStable, '7.1.2');
  assert.equal(status.wordpress.latestPrerelease, '7.2-RC1');

  const badges = buildBadges(status);
  const wordpress = badges[`${BADGES_DIR}/wordpress.json`];
  assert.equal(wordpress.message, '7.1.2');
  assert.equal(wordpress.color, 'blue');
});

test('buildStatus + buildBadges: an empty variant yields nulls and a "none" badge', () => {
  const packages = { [NO_CONTENT]: {}, [FULL]: entries(['7.1.2']) };
  const status = buildStatus(packages, null);
  assert.deepEqual(status.packages[NO_CONTENT], { latest: null, latestStable: null, count: 0 });

  const badges = buildBadges(status);
  const badge = badges[`${BADGES_DIR}/wordpress-core-no-content.json`];
  assert.equal(badge.message, 'none');
  assert.equal(badge.color, 'lightgrey');
});

test('buildBadges: pickup null -> "not measured yet"', () => {
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: {} }, null);
  const badges = buildBadges(status);
  const lag = badges[`${BADGES_DIR}/pickup-lag.json`];
  assert.equal(lag.message, 'not measured yet');
  assert.equal(lag.color, 'lightgrey');
});

test('buildBadges: a real pickup -> message is "9m 33s (7.1.2)"', () => {
  const pickup = {
    version: '7.1.2',
    publishedAt: '2026-09-19T09:12:04Z',
    observedAt: '2026-09-19T09:21:37Z',
    lagSeconds: 573
  };
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: entries(['7.1.2']) }, pickup);
  const badges = buildBadges(status);
  const lag = badges[`${BADGES_DIR}/pickup-lag.json`];
  assert.equal(lag.message, '9m 33s (7.1.2)');
  assert.equal(lag.color, 'informational');
});

test('buildStatus: determinism - two calls on the same input produce byte-identical JSON.stringify output', () => {
  const packages = {
    [NO_CONTENT]: entries(['7.1.0', '7.1.1', '7.1.2']),
    [FULL]: entries(['7.0.0', '7.1.2', '7.2-RC1'])
  };
  const pickup = {
    version: '7.1.2',
    publishedAt: '2026-09-19T09:12:04Z',
    observedAt: '2026-09-19T09:21:37Z',
    lagSeconds: 573
  };
  const a = JSON.stringify(buildStatus(packages, pickup));
  const b = JSON.stringify(buildStatus(packages, pickup));
  assert.equal(a, b);
});

test('readPickup: missing file -> null, no throw', () => {
  assert.equal(readPickup('/nonexistent/does-not-exist/status.json'), null);
});

test('readPickup: malformed JSON -> null, no throw', () => {
  return withTempDir(async (dir) => {
    const file = path.join(dir, 'status.json');
    fs.writeFileSync(file, '{ not valid json');
    assert.equal(readPickup(file), null);
  });
});

test('readPickup: pickup present but not a version object -> null', () => {
  return withTempDir(async (dir) => {
    const file = path.join(dir, 'status.json');
    fs.writeFileSync(file, JSON.stringify({ pickup: {} }));
    assert.equal(readPickup(file), null);
  });
});

test('readPickup: a real pickup object is returned verbatim', () => {
  return withTempDir(async (dir) => {
    const file = path.join(dir, 'status.json');
    const pickup = { version: '7.1.2', publishedAt: 'a', observedAt: 'b', lagSeconds: 5 };
    fs.writeFileSync(file, JSON.stringify({ pickup }));
    assert.deepEqual(readPickup(file), pickup);
  });
});

test('writeStatusFiles: creates all five files with a trailing newline and two-space indent', () => {
  return withTempDir(async (dir) => {
    const status = buildStatus(
      { [NO_CONTENT]: entries(['7.1.2']), [FULL]: entries(['7.1.2', '7.2-RC1']) },
      null
    );
    writeStatusFiles(dir, status);

    const files = [
      STATUS_FILE,
      `${BADGES_DIR}/wordpress-core.json`,
      `${BADGES_DIR}/wordpress-core-no-content.json`,
      `${BADGES_DIR}/wordpress.json`,
      `${BADGES_DIR}/pickup-lag.json`
    ];

    for (const relativePath of files) {
      const fullPath = path.join(dir, relativePath);
      assert.ok(fs.existsSync(fullPath), `${relativePath} should exist`);
      const text = fs.readFileSync(fullPath, 'utf8');
      assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${relativePath} should end with exactly one newline`);
      const body = text.slice(0, -1);
      assert.equal(JSON.stringify(JSON.parse(body), null, 2), body, `${relativePath} should be two-space indented`);
    }
  });
});
