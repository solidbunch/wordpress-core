'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseHeaderDate, toIso, formatLag } = require('../lib/time');

test('formatLag: boundary values render the largest two units, clamped to zero', () => {
  assert.equal(formatLag(0), '0s');
  assert.equal(formatLag(59 * 1000), '59s');
  assert.equal(formatLag(60 * 1000), '1m 0s');
  assert.equal(formatLag((59 * 60 + 59) * 1000), '59m 59s');
  assert.equal(formatLag(60 * 60 * 1000), '1h 0m');
  assert.equal(formatLag((23 * 3600 + 59 * 60) * 1000), '23h 59m');
  assert.equal(formatLag(24 * 60 * 60 * 1000), '1d 0h');
  assert.equal(formatLag(-5), '0s');
});

test('parseHeaderDate: a valid HTTP header string parses to a Date', () => {
  const date = parseHeaderDate('Fri, 19 Sep 2026 09:12:04 GMT');
  assert.ok(date instanceof Date);
  assert.equal(date.toISOString(), '2026-09-19T09:12:04.000Z');
});

test('parseHeaderDate: an empty string returns null', () => {
  assert.equal(parseHeaderDate(''), null);
});

test('parseHeaderDate: a non-string value returns null', () => {
  assert.equal(parseHeaderDate(undefined), null);
  assert.equal(parseHeaderDate(1234567890), null);
  assert.equal(parseHeaderDate(null), null);
});

test('parseHeaderDate: an unparseable string returns null', () => {
  assert.equal(parseHeaderDate('not a date'), null);
});

test('toIso: truncates milliseconds to a "Z"-suffixed second-precision string', () => {
  const date = new Date('2026-09-19T09:21:37.456Z');
  assert.equal(toIso(date), '2026-09-19T09:21:37Z');
});
