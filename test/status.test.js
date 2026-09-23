'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempDir } = require('./helpers');
const { buildStatus, buildBadges, readPickup, writeStatusFiles, STATUS_FILE, BADGES_DIR } = require('../lib/status');
const { selectPickup } = require('../generate-packages-json');

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
  // "latest stable", not "WordPress tracked": the number comes from our own packages.json, so a
  // label implying an upstream reading would oversell it - and this is the one case where it does
  // not simply repeat the variant badge, which shows the prerelease.
  assert.equal(wordpress.label, 'latest stable');
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

test('buildBadges: pickup null -> both lag badges read "not measured yet"', () => {
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: {} }, null);
  const badges = buildBadges(status);

  for (const file of ['pickup-lag', 'reaction-lag']) {
    const badge = badges[`${BADGES_DIR}/${file}.json`];
    assert.equal(badge.message, 'not measured yet', file);
    assert.equal(badge.color, 'lightgrey', file);
  }
});

test('buildBadges: an archive built after the previous check leaves wordpress.org nothing provable', () => {
  // The fast path: the file appeared mid-interval and was taken on the very next cycle, so the
  // whole 9m 33s may be ours and none of it is demonstrably wordpress.org's.
  const pickup = {
    version: '7.1.2',
    publishedAt: '2026-09-19T09:12:04Z',
    observedAt: '2026-09-19T09:21:37Z',
    lagSeconds: 573,
    batchSize: 1,
    previousCheckAt: '2026-09-19T09:06:12Z',
    reactionSeconds: 925
  };
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: entries(['7.1.2']) }, pickup);
  const badges = buildBadges(status);
  const lag = badges[`${BADGES_DIR}/pickup-lag.json`];
  assert.equal(lag.label, 'wordpress.org \u2192 package');
  assert.equal(lag.message, '0s (7.1.2)');
  assert.equal(lag.color, 'informational');

  // Our bound tightens to the total: we cannot have been slower than the archive has existed.
  assert.equal(badges[`${BADGES_DIR}/reaction-lag.json`].message, '9m 33s');
});

test('buildBadges: a backport wave names the batch size so it cannot read as our stall', () => {
  const pickup = {
    version: '4.7.37',
    publishedAt: '2026-09-22T18:07:53Z',
    observedAt: '2026-09-22T19:00:47Z',
    lagSeconds: 3174,
    batchSize: 19,
    previousCheckAt: '2026-09-22T18:45:23Z',
    reactionSeconds: 924
  };
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: entries(['4.7.37']) }, pickup);
  const badges = buildBadges(status);
  assert.equal(badges[`${BADGES_DIR}/pickup-lag.json`].message, '37m 30s (4.7.37, newest of 19)');
});

test('buildBadges: the reaction badge states an upper bound, not a figure', () => {
  const pickup = {
    version: '4.7.37',
    publishedAt: '2026-09-22T18:07:53Z',
    observedAt: '2026-09-22T19:00:47Z',
    lagSeconds: 3174,
    batchSize: 19,
    previousCheckAt: '2026-09-22T18:45:23Z',
    reactionSeconds: 924
  };
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: entries(['4.7.37']) }, pickup);
  const badge = buildBadges(status)[`${BADGES_DIR}/reaction-lag.json`];
  assert.equal(badge.label, 'pickup reaction');
  assert.equal(badge.message, '15m 24s');
  assert.equal(badge.color, 'informational');
});

test('buildBadges: the two shares are disjoint and add up to the whole delay', () => {
  // This is the property the split exists for: neither badge contains the other, so a reader can
  // tell whose time the delay was instead of reading one total as though it were all ours.
  const cases = [
    { name: 'backport wave', lagSeconds: 3174, reactionSeconds: 924, theirs: '37m 30s', ours: '15m 24s' },
    { name: 'built after the check', lagSeconds: 573, reactionSeconds: 925, theirs: '0s', ours: '9m 33s' },
    { name: 'exactly one interval', lagSeconds: 900, reactionSeconds: 900, theirs: '0s', ours: '15m 0s' }
  ];

  for (const { name, lagSeconds, reactionSeconds, theirs, ours } of cases) {
    const pickup = {
      version: '7.1.2',
      publishedAt: '2026-09-19T09:12:04Z',
      observedAt: '2026-09-19T09:21:37Z',
      lagSeconds,
      batchSize: 1,
      previousCheckAt: '2026-09-19T09:06:12Z',
      reactionSeconds
    };
    const badges = buildBadges(buildStatus({ [NO_CONTENT]: {}, [FULL]: {} }, pickup));

    assert.equal(badges[`${BADGES_DIR}/pickup-lag.json`].message, `${theirs} (7.1.2)`, name);
    assert.equal(badges[`${BADGES_DIR}/reaction-lag.json`].message, `${ours}`, name);
    assert.equal(
      Math.max(0, lagSeconds - reactionSeconds) + Math.min(lagSeconds, reactionSeconds),
      lagSeconds,
      `${name}: the two shares must account for the whole delay`
    );
  }
});

test('buildBadges: a pickup carried over from before the split still renders both badges', () => {
  const pickup = {
    version: '7.1.2',
    publishedAt: '2026-09-19T09:12:04Z',
    observedAt: '2026-09-19T09:21:37Z',
    lagSeconds: 573
  };
  const status = buildStatus({ [NO_CONTENT]: {}, [FULL]: entries(['7.1.2']) }, pickup);
  const badges = buildBadges(status);

  // No batchSize reads as a single release, and an unmeasured reaction says so rather than
  // inventing a number from the fields that happen to be there.
  assert.equal(badges[`${BADGES_DIR}/pickup-lag.json`].message, '9m 33s (7.1.2)');
  assert.equal(badges[`${BADGES_DIR}/reaction-lag.json`].message, 'not measured yet');
  assert.equal(badges[`${BADGES_DIR}/reaction-lag.json`].color, 'lightgrey');
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

test('selectPickup: two variants of one version count once and yield the newer archive', () => {
  const now = new Date('2026-09-19T09:21:37Z');
  const rows = [
    { version: '7.1.2', package: NO_CONTENT, lastModified: 'Fri, 18 Sep 2026 09:12:04 GMT' },
    { version: '7.1.2', package: FULL, lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' }
  ];
  const pickup = selectPickup(rows, now);
  assert.equal(pickup.version, '7.1.2');
  assert.equal(pickup.publishedAt, '2026-09-19T09:12:04Z');
  assert.equal(pickup.observedAt, '2026-09-19T09:21:37Z');
  assert.equal(pickup.batchSize, 1);
});

test('selectPickup: an unparseable Last-Modified header is excluded', () => {
  const now = new Date('2026-09-19T09:21:37Z');
  const rows = [{ version: '7.1.2', package: FULL, lastModified: 'not a date' }];
  assert.equal(selectPickup(rows, now), undefined);
});

test('selectPickup: an empty row list -> undefined', () => {
  assert.equal(selectPickup([], new Date('2026-09-19T09:21:37Z')), undefined);
});

test('selectPickup: the newest archive wins, not the highest version number', () => {
  // wordpress.org builds a backport wave newest-branch-first, so the highest version number is the
  // FIRST file built and carries the whole build queue in its age. 6.5.12 here is that trap.
  const now = new Date('2026-09-22T19:00:47Z');
  const rows = [
    { version: '6.5.12', package: FULL, lastModified: 'Tue, 22 Sep 2026 16:35:19 GMT' },
    { version: '6.0.16', package: FULL, lastModified: 'Tue, 22 Sep 2026 17:12:09 GMT' },
    { version: '4.7.37', package: FULL, lastModified: 'Tue, 22 Sep 2026 18:07:53 GMT' }
  ];
  const pickup = selectPickup(rows, now);
  assert.equal(pickup.version, '4.7.37');
  assert.equal(pickup.publishedAt, '2026-09-22T18:07:53Z');
  assert.equal(pickup.lagSeconds, 3174);
  assert.equal(pickup.batchSize, 3);
});

test('selectPickup: batchSize counts versions, not rows', () => {
  const now = new Date('2026-09-19T09:21:37Z');
  const rows = [
    { version: '7.1.2', package: NO_CONTENT, lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' },
    { version: '7.1.2', package: FULL, lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' },
    { version: '7.0.6', package: NO_CONTENT, lastModified: 'Fri, 19 Sep 2026 09:10:00 GMT' },
    { version: '7.0.6', package: FULL, lastModified: 'Fri, 19 Sep 2026 09:10:00 GMT' }
  ];
  assert.equal(selectPickup(rows, now).batchSize, 2);
});

test('selectPickup: a previous check time yields the reaction bound; without one it stays null', () => {
  const now = new Date('2026-09-22T19:00:47Z');
  const rows = [{ version: '4.7.37', package: FULL, lastModified: 'Tue, 22 Sep 2026 18:07:53 GMT' }];

  const measured = selectPickup(rows, now, new Date('2026-09-22T18:45:23Z'));
  assert.equal(measured.previousCheckAt, '2026-09-22T18:45:23Z');
  assert.equal(measured.reactionSeconds, 924);

  const unmeasured = selectPickup(rows, now);
  assert.equal(unmeasured.previousCheckAt, null);
  assert.equal(unmeasured.reactionSeconds, null);
});

test('selectPickup: a previous check newer than the commit clamps to zero instead of going negative', () => {
  const now = new Date('2026-09-22T19:00:47Z');
  const rows = [{ version: '4.7.37', package: FULL, lastModified: 'Tue, 22 Sep 2026 18:07:53 GMT' }];
  const pickup = selectPickup(rows, now, new Date('2026-09-22T19:05:00Z'));
  assert.equal(pickup.reactionSeconds, 0);
});

test('writeStatusFiles: creates all six files with a trailing newline and two-space indent', () => {
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
      `${BADGES_DIR}/pickup-lag.json`,
      `${BADGES_DIR}/reaction-lag.json`
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
