'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEntry, storedFields, newFields } = require('../generate-packages-json');
const { VARIANTS, HOMEPAGE, SUPPORT, CORE_IMPLEMENTATION, SOURCE_URL } = require('../lib/constants');
const { distUrl } = require('../lib/util');

const SHASUM = 'a'.repeat(40);
const [noContent, full] = VARIANTS;

const FULL_KEY_ORDER = ['name', 'version', 'type', 'description', 'keywords', 'homepage', 'license', 'support', 'require', 'provide', 'source', 'dist'];
const NO_CONTENT_KEY_ORDER = ['name', 'version', 'type', 'description', 'keywords', 'homepage', 'license', 'support', 'require', 'provide', 'dist'];

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
  for (const [variant, keyOrder] of [[noContent, NO_CONTENT_KEY_ORDER], [full, FULL_KEY_ORDER]]) {
    const url = distUrl(variant, '6.9');
    const entry = buildEntry(variant, fields(variant, undefined), url, SHASUM);
    assert.deepEqual(Object.keys(entry), keyOrder);
    assert.equal(entry.name, variant.name);
    assert.equal(entry.version, '6.9');
    assert.equal(entry.type, 'wordpress-core');
    assert.equal(entry.description, variant.description);
    assert.deepEqual(entry.keywords, variant.keywords);
    assert.equal(entry.homepage, HOMEPAGE);
    assert.equal(entry.license, 'GPL-2.0-or-later');
    assert.deepEqual(entry.support, SUPPORT);
    assert.deepEqual(entry.require, { php: '>=7.4' });
    assert.deepEqual(entry.provide, { [CORE_IMPLEMENTATION]: '6.9' });
    assert.deepEqual(entry.dist, { type: 'zip', url, shasum: SHASUM });
    assert.equal(entry.extra, undefined);
  }
});

test('buildEntry appends extra last when present, for both variants', () => {
  for (const [variant, keyOrder] of [[noContent, NO_CONTENT_KEY_ORDER], [full, FULL_KEY_ORDER]]) {
    const url = distUrl(variant, '6.9');
    const entry = buildEntry(variant, fields(variant, { mysql_version: '5.5.5' }), url, SHASUM);
    assert.deepEqual(Object.keys(entry), [...keyOrder, 'extra']);
    assert.deepEqual(entry.extra, { mysql_version: '5.5.5' });
  }
});

test('buildEntry includes source only for the full variant', () => {
  const fullEntry = buildEntry(full, fields(full, undefined), distUrl(full, '6.9'), SHASUM);
  assert.deepEqual(fullEntry.source, { type: 'git', url: SOURCE_URL, reference: '6.9' });

  const noContentEntry = buildEntry(noContent, fields(noContent, undefined), distUrl(noContent, '6.9'), SHASUM);
  assert.equal(noContentEntry.source, undefined);
  assert.ok(!Object.hasOwn(noContentEntry, 'source'));
});

test('buildEntry emits fresh copies of support and keywords, never aliasing the frozen constants', () => {
  const entryA = buildEntry(full, fields(full, undefined), distUrl(full, '6.9'), SHASUM);
  const entryB = buildEntry(full, fields(full, undefined), distUrl(full, '6.9'), SHASUM);
  assert.notEqual(entryA.support, entryB.support);
  assert.notEqual(entryA.keywords, entryB.keywords);
  assert.notEqual(entryA.support, SUPPORT);
  assert.notEqual(entryA.keywords, full.keywords);
});

test('storedFields/buildEntry round trip: rebuilding a stored entry reproduces its own inputs', () => {
  const url = distUrl(full, '6.9');
  const originalFields = fields(full, { mysql_version: '5.5.5' });
  const entry = buildEntry(full, originalFields, url, SHASUM);
  assert.deepEqual(storedFields(entry), originalFields);
});

test('storedFields/buildEntry round trip without extra', () => {
  const url = distUrl(noContent, '6.9');
  const originalFields = fields(noContent, undefined);
  const entry = buildEntry(noContent, originalFields, url, SHASUM);
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
