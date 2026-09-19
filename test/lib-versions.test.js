'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { versionParts, compareVersions, findDuplicates } = require('../lib/versions');
const { distUrl, normalizeHost } = require('../lib/util');
const { VARIANTS } = require('../lib/constants');

test('versionParts pads to three numeric components', () => {
  assert.deepEqual(versionParts('4.1'), [4, 1, 0]);
  assert.deepEqual(versionParts('4.1.2'), [4, 1, 2]);
  assert.deepEqual(versionParts('10'), [10, 0, 0]);
});

test('compareVersions orders and is transitive over a fixed list', () => {
  const ordered = ['4.1', '4.1.2', '4.2', '5.0', '5.0.1', '6.9.1'];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(compareVersions(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
    assert.ok(compareVersions(ordered[i], ordered[i - 1]) > 0, `${ordered[i]} > ${ordered[i - 1]}`);
  }
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      for (let k = 0; k < ordered.length; k++) {
        if (compareVersions(ordered[i], ordered[j]) <= 0 && compareVersions(ordered[j], ordered[k]) <= 0) {
          assert.ok(compareVersions(ordered[i], ordered[k]) <= 0, `transitivity: ${ordered[i]} <= ${ordered[k]}`);
        }
      }
    }
  }
  assert.equal(compareVersions('4.1', '4.1.0'), 0);
});

test('findDuplicates treats "4.1" and "4.1.0" as the same version', () => {
  const duplicates = findDuplicates(['4.1', '4.1.0']);
  assert.equal(duplicates.length, 1);
  assert.match(duplicates[0], /^DUPLICATE-VERSION: 4\.1 == 4\.1\.0$/);
});

test('distUrl builds the canonical download URL per variant', () => {
  const noContent = VARIANTS.find((variant) => variant.suffix === '-no-content');
  const full = VARIANTS.find((variant) => variant.suffix === '');
  assert.equal(distUrl(noContent, '6.9.1'), 'https://downloads.wordpress.org/release/wordpress-6.9.1-no-content.zip');
  assert.equal(distUrl(full, '6.9.1'), 'https://downloads.wordpress.org/release/wordpress-6.9.1.zip');
});

test('normalizeHost rewrites protocol and host to the canonical download host', () => {
  assert.equal(
    normalizeHost('http://downloads.wordpress.org/release/wordpress-6.9.zip'),
    'https://downloads.wordpress.org/release/wordpress-6.9.zip'
  );
  assert.equal(
    normalizeHost('https://evil.example.com/release/wordpress-6.9.zip'),
    'https://downloads.wordpress.org/release/wordpress-6.9.zip'
  );
});

test('normalizeHost(undefined) is undefined', () => {
  assert.equal(normalizeHost(undefined), undefined);
});
