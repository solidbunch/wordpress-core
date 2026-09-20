'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildTagComposerJson, serializeTagComposerJson } = require('../lib/tag-composer');
const { readPackagesFile } = require('../lib/packages-file');
const { VARIANTS } = require('../lib/constants');

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

for (const { variant, version, entry } of cases) {
  test(`buildTagComposerJson(${variant.name}) deep-equals the real packages.json entry for ${version}`, () => {
    const result = buildTagComposerJson(variant, entry);
    assert.deepEqual(result, entry);
    assert.deepEqual(Object.keys(result), Object.keys(entry));
  });

  test(`buildTagComposerJson(${variant.name}) returns a deep clone, not the same reference, for ${version}`, () => {
    const result = buildTagComposerJson(variant, entry);
    assert.notEqual(result, entry);
    assert.notEqual(result.dist, entry.dist);

    const beforeMutation = JSON.parse(JSON.stringify(entry));
    result.version = 'mutated';
    result.dist.shasum = 'mutated';
    if (result.extra) result.extra.mysql_version = 'mutated';

    assert.deepEqual(entry, beforeMutation);
  });
}

test('serializeTagComposerJson ends with exactly one trailing newline and round-trips through JSON.parse', () => {
  const { entry } = cases[0];
  const result = buildTagComposerJson(cases[0].variant, entry);
  const serialized = serializeTagComposerJson(result);

  assert.ok(serialized.endsWith('\n'));
  assert.ok(!serialized.endsWith('\n\n'));

  const parsedBack = JSON.parse(serialized);
  assert.deepEqual(parsedBack, entry);
});
