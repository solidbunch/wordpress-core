'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate, validateEntry, buildEntry } = require('../generate-packages-json');
const { VARIANTS, LICENSE } = require('../lib/constants');
const { distUrl } = require('../lib/util');

const SHASUM = 'a'.repeat(40);
const [noContent, full] = VARIANTS;

function entryFor(variant, version) {
  return buildEntry(
    variant,
    { name: variant.name, version, type: 'wordpress-core', require: { php: '>=7.4' }, distType: 'zip', extra: undefined },
    distUrl(variant, version),
    SHASUM
  );
}

function validPackages(version = '6.9') {
  return {
    [noContent.name]: { [version]: entryFor(noContent, version) },
    [full.name]: { [version]: entryFor(full, version) }
  };
}

function violationsFor(prefix, violations) {
  return violations.filter((v) => v.startsWith(`${prefix}:`));
}

test('validate: a well-formed document produces zero violations', () => {
  assert.deepEqual(validate(validPackages(), {}), []);
});

test('validate: PACKAGES when the package set or order is wrong', () => {
  const swapped = { [full.name]: validPackages()[full.name], [noContent.name]: validPackages()[noContent.name] };
  assert.equal(violationsFor('PACKAGES', validate(swapped, {})).length, 1);

  const extraPackage = { ...validPackages(), 'solidbunch/unknown': {} };
  assert.equal(violationsFor('PACKAGES', validate(extraPackage, {})).length, 1);
});

test('validate: EMPTY-PACKAGE when a variant has no versions', () => {
  const packages = validPackages();
  packages[noContent.name] = {};
  assert.equal(violationsFor('EMPTY-PACKAGE', validate(packages, {})).length, 1);
});

test('validate: BAD-VERSION-KEY when an entry key is not a stable version string', () => {
  const packages = validPackages();
  packages[full.name]['not-a-version'] = entryFor(full, 'not-a-version');
  assert.equal(violationsFor('BAD-VERSION-KEY', validate(packages, {})).length, 1);
});

test('validate: DUPLICATE-VERSION when two keys are the same Composer version', () => {
  const packages = validPackages('6.9');
  packages[full.name]['6.9.0'] = entryFor(full, '6.9.0');
  assert.equal(violationsFor('DUPLICATE-VERSION', validate(packages, {})).length, 1);
});

test('validate: ORDER when versions are not strictly descending', () => {
  const packages = {
    [noContent.name]: { '6.8': entryFor(noContent, '6.8'), '6.9': entryFor(noContent, '6.9') },
    [full.name]: { '6.8': entryFor(full, '6.8'), '6.9': entryFor(full, '6.9') }
  };
  assert.equal(violationsFor('ORDER', validate(packages, {})).length, 2);
});

test('validate: LOST-VERSION when a previous version disappears from the file', () => {
  const previous = validPackages('6.8');
  const packages = validPackages('6.9');
  const violations = validate(packages, previous);
  assert.equal(violationsFor('LOST-VERSION', violations).length, 2);
});

test('validate: SHRUNK when a variant has fewer entries than the previous file', () => {
  const previous = {
    [noContent.name]: { '6.8': entryFor(noContent, '6.8'), '6.9': entryFor(noContent, '6.9') },
    [full.name]: { '6.8': entryFor(full, '6.8'), '6.9': entryFor(full, '6.9') }
  };
  const packages = validPackages('6.9');
  const violations = validate(packages, previous);
  assert.ok(violationsFor('SHRUNK', violations).length >= 1);
});

test('validateEntry: a well-formed entry produces zero violations', () => {
  assert.deepEqual(validateEntry(full, '6.9', entryFor(full, '6.9')), []);
  assert.deepEqual(validateEntry(noContent, '6.9', entryFor(noContent, '6.9')), []);
});

test('validateEntry: MALFORMED when the entry is not an object', () => {
  assert.deepEqual(validateEntry(full, '6.9', null), [`MALFORMED: ${full.name} 6.9 is not an object`]);
  assert.deepEqual(validateEntry(full, '6.9', 'not-an-object'), [`MALFORMED: ${full.name} 6.9 is not an object`]);
});

test('validateEntry: NAME when entry.name does not match the variant', () => {
  const entry = { ...entryFor(full, '6.9'), name: 'wrong/name' };
  assert.equal(violationsFor('NAME', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: VERSION when entry.version does not match the key', () => {
  const entry = { ...entryFor(full, '6.9'), version: '6.8' };
  assert.equal(violationsFor('VERSION', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: TYPE when entry.type is not wordpress-core', () => {
  const entry = { ...entryFor(full, '6.9'), type: 'library' };
  assert.equal(violationsFor('TYPE', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: LICENSE when entry.license does not match the required license', () => {
  const entry = { ...entryFor(full, '6.9'), license: 'MIT' };
  assert.equal(violationsFor('LICENSE', validateEntry(full, '6.9', entry)).length, 1);
  assert.equal(entryFor(full, '6.9').license, LICENSE);
});

test('validateEntry: REQUIRE when require is missing, has extra keys, or a malformed php constraint', () => {
  const base = entryFor(full, '6.9');
  assert.equal(violationsFor('REQUIRE', validateEntry(full, '6.9', { ...base, require: undefined })).length, 1);
  assert.equal(violationsFor('REQUIRE', validateEntry(full, '6.9', { ...base, require: { php: '>=7.4', extra: 'x' } })).length, 1);
  assert.equal(violationsFor('REQUIRE', validateEntry(full, '6.9', { ...base, require: { php: '7.4' } })).length, 1);
});

test('validateEntry: DIST when the entry has no dist object', () => {
  const entry = { ...entryFor(full, '6.9'), dist: undefined };
  assert.equal(violationsFor('DIST', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: DIST-TYPE when dist.type is not zip', () => {
  const base = entryFor(full, '6.9');
  const entry = { ...base, dist: { ...base.dist, type: 'tar' } };
  assert.equal(violationsFor('DIST-TYPE', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: URL when dist.url is not the canonical download URL', () => {
  const base = entryFor(full, '6.9');
  const entry = { ...base, dist: { ...base.dist, url: 'https://example.com/wordpress-6.9.zip' } };
  assert.equal(violationsFor('URL', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: SHASUM when dist.shasum is not 40 lowercase hex characters', () => {
  const base = entryFor(full, '6.9');
  assert.equal(violationsFor('SHASUM', validateEntry(full, '6.9', { ...base, dist: { ...base.dist, shasum: 'not-a-shasum' } })).length, 1);
  assert.equal(violationsFor('SHASUM', validateEntry(full, '6.9', { ...base, dist: { ...base.dist, shasum: undefined } })).length, 1);
});

test('validateEntry: EXTRA when extra has unexpected shape', () => {
  const base = entryFor(full, '6.9');
  assert.equal(violationsFor('EXTRA', validateEntry(full, '6.9', { ...base, extra: { mysql_version: 5 } })).length, 1);
  assert.equal(violationsFor('EXTRA', validateEntry(full, '6.9', { ...base, extra: { mysql_version: '5.5.5', other: 'x' } })).length, 1);
  assert.deepEqual(validateEntry(full, '6.9', { ...base, extra: { mysql_version: '5.5.5' } }), []);
});

test('validateEntry: DESCRIPTION when entry.description does not match the variant', () => {
  const entry = { ...entryFor(full, '6.9'), description: 'wrong' };
  assert.equal(violationsFor('DESCRIPTION', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: KEYWORDS when entry.keywords does not match the variant', () => {
  const entry = { ...entryFor(full, '6.9'), keywords: ['wrong'] };
  assert.equal(violationsFor('KEYWORDS', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: HOMEPAGE when entry.homepage is not the canonical URL', () => {
  const entry = { ...entryFor(full, '6.9'), homepage: 'https://example.com' };
  assert.equal(violationsFor('HOMEPAGE', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: SUPPORT when entry.support does not match the canonical object', () => {
  const entry = { ...entryFor(full, '6.9'), support: { issues: 'https://example.com' } };
  assert.equal(violationsFor('SUPPORT', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: PROVIDE when entry.provide does not point at the key version', () => {
  const entry = { ...entryFor(full, '6.9'), provide: { 'wordpress/core-implementation': '6.8' } };
  assert.equal(violationsFor('PROVIDE', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: SOURCE when the full variant has a wrong source', () => {
  const base = entryFor(full, '6.9');
  const entry = { ...base, source: { ...base.source, reference: '6.8' } };
  assert.equal(violationsFor('SOURCE', validateEntry(full, '6.9', entry)).length, 1);
});

test('validateEntry: SOURCE when the no-content variant declares a source', () => {
  const base = entryFor(noContent, '6.9');
  const entry = { ...base, source: { type: 'git', url: 'https://github.com/WordPress/WordPress.git', reference: '6.9' } };
  assert.deepEqual(validateEntry(noContent, '6.9', entry), [`SOURCE: ${noContent.name} 6.9 must not declare a source`]);
});

test('validateEntry: UNKNOWN-FIELD when the entry carries a field outside the allowed set', () => {
  const entry = { ...entryFor(full, '6.9'), unexpected: 'x' };
  assert.deepEqual(violationsFor('UNKNOWN-FIELD', validateEntry(full, '6.9', entry)), [`UNKNOWN-FIELD: ${full.name} 6.9 has unexpected field(s) ["unexpected"]`]);
});
