'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEntry, storedFields, newFields } = require('../generate-packages-json');
const { VARIANTS } = require('../lib/constants');
const { distUrl } = require('../lib/util');

const SHASUM = 'a'.repeat(40);
const [noContent, full] = VARIANTS;

function fields(variant, extra) {
  return {
    name: variant.name,
    version: '6.9',
    type: 'wordpress-core',
    require: { php: '>=7.4' },
    distType: 'zip',
    extra
  };
}

test('buildEntry emits the expected key order without extra, for both variants', () => {
  for (const variant of [noContent, full]) {
    const url = distUrl(variant, '6.9');
    const entry = buildEntry(fields(variant, undefined), url, SHASUM);
    assert.deepEqual(Object.keys(entry), ['name', 'version', 'type', 'license', 'require', 'dist']);
    assert.equal(entry.name, variant.name);
    assert.equal(entry.version, '6.9');
    assert.equal(entry.type, 'wordpress-core');
    assert.equal(entry.license, 'GPL-2.0-or-later');
    assert.deepEqual(entry.require, { php: '>=7.4' });
    assert.deepEqual(entry.dist, { type: 'zip', url, shasum: SHASUM });
    assert.equal(entry.extra, undefined);
  }
});

test('buildEntry appends extra last when present, for both variants', () => {
  for (const variant of [noContent, full]) {
    const url = distUrl(variant, '6.9');
    const entry = buildEntry(fields(variant, { mysql_version: '5.5.5' }), url, SHASUM);
    assert.deepEqual(Object.keys(entry), ['name', 'version', 'type', 'license', 'require', 'dist', 'extra']);
    assert.deepEqual(entry.extra, { mysql_version: '5.5.5' });
  }
});

test('storedFields/buildEntry round trip: rebuilding a stored entry reproduces its own inputs', () => {
  const url = distUrl(full, '6.9');
  const originalFields = fields(full, { mysql_version: '5.5.5' });
  const entry = buildEntry(originalFields, url, SHASUM);
  assert.deepEqual(storedFields(entry), originalFields);
});

test('storedFields/buildEntry round trip without extra', () => {
  const url = distUrl(noContent, '6.9');
  const originalFields = fields(noContent, undefined);
  const entry = buildEntry(originalFields, url, SHASUM);
  assert.deepEqual(storedFields(entry), originalFields);
});

test('storedFields tolerates a missing dist object', () => {
  assert.deepEqual(storedFields(undefined), {
    name: undefined,
    version: undefined,
    type: undefined,
    require: undefined,
    distType: undefined,
    extra: undefined
  });
});

test('newFields builds buildEntry inputs from variant, version and metadata', () => {
  assert.deepEqual(
    newFields(full, '6.9', { php: '>=7.4', extra: { mysql_version: '5.5.5' } }),
    {
      name: full.name,
      version: '6.9',
      type: 'wordpress-core',
      require: { php: '>=7.4' },
      distType: 'zip',
      extra: { mysql_version: '5.5.5' }
    }
  );
});

test('newFields omits extra when metadata has none', () => {
  assert.deepEqual(
    newFields(noContent, '6.9', { php: '>=7.4', extra: undefined }),
    {
      name: noContent.name,
      version: '6.9',
      type: 'wordpress-core',
      require: { php: '>=7.4' },
      distType: 'zip',
      extra: undefined
    }
  );
});
