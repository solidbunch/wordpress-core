'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVersionPhp,
  readVersionPhpAssignment,
  metadataFromOffer,
  metadataFromSibling
} = require('../generate-packages-json');
const { readFixture } = require('./helpers');

test('parseVersionPhp reads a real version.php fixture', () => {
  const text = readFixture('version.php.txt');
  assert.deepEqual(parseVersionPhp(text), { php: '>=7.2', extra: { mysql_version: '5.5.5' } });
});

test('parseVersionPhp returns null when $required_php_version is assigned twice', () => {
  const text = `
    $required_php_version = '7.2.24';
    $required_php_version = '7.4.0';
    $required_mysql_version = '5.5.5';
  `;
  assert.equal(parseVersionPhp(text), null);
});

test('parseVersionPhp returns null when $required_mysql_version is missing', () => {
  const text = `
    $required_php_version = '7.2.24';
  `;
  assert.equal(parseVersionPhp(text), null);
});

test('readVersionPhpAssignment returns the single quoted assignment', () => {
  const text = `$required_php_version = '7.2.24';`;
  assert.equal(readVersionPhpAssignment(text, 'required_php_version'), '7.2.24');
});

test('readVersionPhpAssignment returns null when the assignment is absent', () => {
  assert.equal(readVersionPhpAssignment('', 'required_php_version'), null);
});

test('readVersionPhpAssignment returns null when the assignment appears twice', () => {
  const text = `
    $required_php_version = '7.2.24';
    $required_php_version = '7.4.0';
  `;
  assert.equal(readVersionPhpAssignment(text, 'required_php_version'), null);
});

test('metadataFromOffer builds php requirement and mysql extra from a version-check offer', () => {
  assert.deepEqual(
    metadataFromOffer({ php_version: '7.4.33', mysql_version: '5.5.5' }),
    { php: '>=7.4', extra: { mysql_version: '5.5.5' } }
  );
});

test('metadataFromOffer omits extra when mysql_version is missing', () => {
  assert.deepEqual(metadataFromOffer({ php_version: '7.4.33' }), { php: '>=7.4', extra: undefined });
});

test('metadataFromOffer omits extra when mysql_version is an empty string', () => {
  assert.deepEqual(
    metadataFromOffer({ php_version: '7.4.33', mysql_version: '' }),
    { php: '>=7.4', extra: undefined }
  );
});

test('metadataFromOffer returns null for a non-string php_version', () => {
  assert.equal(metadataFromOffer({ php_version: 7.4 }), null);
  assert.equal(metadataFromOffer({}), null);
  assert.equal(metadataFromOffer(null), null);
});

test('metadataFromSibling copies php and extra from the sibling entry', () => {
  const sibling = { require: { php: '>=7.4' }, extra: { mysql_version: '5.5.5' } };
  assert.deepEqual(metadataFromSibling(sibling), { php: '>=7.4', extra: { mysql_version: '5.5.5' } });
});

test('metadataFromSibling tolerates a sibling with no extra', () => {
  const sibling = { require: { php: '>=7.4' } };
  assert.deepEqual(metadataFromSibling(sibling), { php: '>=7.4', extra: undefined });
});
