'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { asymmetricLines, buildEntry } = require('../generate-packages-json');
const { VARIANTS } = require('../lib/constants');
const { distUrl } = require('../lib/util');

const SHASUM = 'a'.repeat(40);
const [noContent, full] = VARIANTS;

function entryFor(variant, version) {
  return buildEntry(
    { name: variant.name, version, type: 'wordpress-core', require: { php: '>=7.4' }, distType: 'zip', extra: undefined },
    distUrl(variant, version),
    SHASUM
  );
}

test('asymmetricLines is empty when both variants carry the same versions', () => {
  const packages = {
    [noContent.name]: { '6.9': entryFor(noContent, '6.9') },
    [full.name]: { '6.9': entryFor(full, '6.9') }
  };
  assert.deepEqual(asymmetricLines(packages), []);
});

test('asymmetricLines reports a version present in only one variant', () => {
  const packages = {
    [noContent.name]: { '6.9': entryFor(noContent, '6.9') },
    [full.name]: {}
  };
  assert.deepEqual(asymmetricLines(packages), [`ASYMMETRIC: 6.9 exists only in ${noContent.name}`]);
});

test('asymmetricLines reports both directions independently', () => {
  const packages = {
    [noContent.name]: { '6.8': entryFor(noContent, '6.8') },
    [full.name]: { '6.9': entryFor(full, '6.9') }
  };
  const lines = asymmetricLines(packages);
  assert.equal(lines.length, 2);
  assert.ok(lines.includes(`ASYMMETRIC: 6.8 exists only in ${noContent.name}`));
  assert.ok(lines.includes(`ASYMMETRIC: 6.9 exists only in ${full.name}`));
});
