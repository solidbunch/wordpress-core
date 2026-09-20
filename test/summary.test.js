'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { formatSummary, writeJobSummary, verifyArchive, buildEntry } = require('../generate-packages-json');
const { startServer, withTempDir } = require('./helpers');

const NOW = new Date('2026-09-19T09:21:37Z');

test('formatSummary: one row per added version, with a known Last-Modified', () => {
  const rows = [{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' }];
  const markdown = formatSummary(rows, NOW);
  assert.match(markdown, /^## Added versions\n\n\| Version \| Package \| Archive published \(Last-Modified\) \| Observed by the generator \| Lag \|\n\| --- \| --- \| --- \| --- \| --- \|\n/);
  assert.match(markdown, /\| 7\.1\.2 \| solidbunch\/wordpress-core \| 2026-09-19T09:12:04Z \| 2026-09-19T09:21:37Z \| 9m 33s \|\n$/);
});

test('formatSummary: renders only a parsed ISO date, never the raw header text', () => {
  const rows = [{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' }];
  const markdown = formatSummary(rows, NOW);
  assert.equal(markdown.includes('GMT'), false);
  assert.equal(markdown.includes('Fri, 19 Sep 2026'), false);
});

test('formatSummary: an absent Last-Modified renders unknown/unknown/em-dash', () => {
  const rows = [{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: undefined }];
  const markdown = formatSummary(rows, NOW);
  assert.match(markdown, /\| 7\.1\.2 \| solidbunch\/wordpress-core \| unknown \| unknown \| — \|/);
});

test('formatSummary: an unparseable Last-Modified renders unknown/unknown/em-dash', () => {
  const rows = [{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: 'not a date' }];
  const markdown = formatSummary(rows, NOW);
  assert.match(markdown, /\| 7\.1\.2 \| solidbunch\/wordpress-core \| unknown \| unknown \| — \|/);
});

test('formatSummary: an empty row list produces no output', () => {
  assert.equal(formatSummary([], NOW), '');
});

test('formatSummary: multiple added versions each get their own row', () => {
  const rows = [
    { version: '7.1.2', package: 'solidbunch/wordpress-core-no-content', lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' },
    { version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT' }
  ];
  const markdown = formatSummary(rows, NOW);
  assert.equal(markdown.match(/^\|/gm).length, 4); // header row + separator row + 2 data rows
  const dataRows = markdown.split('\n').filter((line) => line.startsWith('| 7.1.2'));
  assert.equal(dataRows.length, 2);
});

test('formatSummary: lag formatting spans seconds, minutes, hours and days', () => {
  const row = (isoPublished) => [{ version: 'x', package: 'p', lastModified: new Date(isoPublished).toUTCString() }];
  assert.match(formatSummary(row('2026-09-19T09:21:30Z'), NOW), /\| 7s \|/);
  assert.match(formatSummary(row('2026-09-19T09:12:04Z'), NOW), /\| 9m 33s \|/);
  assert.match(formatSummary(row('2026-09-19T07:00:00Z'), NOW), /\| 2h 21m \|/);
  assert.match(formatSummary(row('2026-09-17T09:21:37Z'), NOW), /\| 2d 0h \|/);
});

test('formatSummary: a "|" in a cell is escaped so it cannot corrupt the table', () => {
  const rows = [{ version: '7.1.2', package: 'solid|bunch/wordpress-core', lastModified: undefined }];
  const markdown = formatSummary(rows, NOW);
  assert.match(markdown, /solid\\\|bunch\/wordpress-core/);
});

test('writeJobSummary: does nothing when GITHUB_STEP_SUMMARY is unset', async () => {
  await withTempDir(async (dir) => {
    const summaryPath = path.join(dir, 'summary.md');
    delete process.env.GITHUB_STEP_SUMMARY;
    writeJobSummary([{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: undefined }]);
    assert.equal(fs.existsSync(summaryPath), false);
  });
});

test('writeJobSummary: appends to (does not overwrite) an existing summary file', async () => {
  await withTempDir(async (dir) => {
    const summaryPath = path.join(dir, 'summary.md');
    fs.writeFileSync(summaryPath, 'existing content\n');
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    try {
      writeJobSummary([{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: undefined }]);
      const content = fs.readFileSync(summaryPath, 'utf8');
      assert.match(content, /^existing content\n/);
      assert.match(content, /## Added versions/);
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
  });
});

test('writeJobSummary: an empty row list writes nothing even when the env var is set', async () => {
  await withTempDir(async (dir) => {
    const summaryPath = path.join(dir, 'summary.md');
    fs.writeFileSync(summaryPath, 'existing content\n');
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    try {
      writeJobSummary([]);
      assert.equal(fs.readFileSync(summaryPath, 'utf8'), 'existing content\n');
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
  });
});

test('writeJobSummary: an I/O error only logs a warning, never throws', () => {
  process.env.GITHUB_STEP_SUMMARY = '/nonexistent-directory-for-test/summary.md';
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);
  try {
    assert.doesNotThrow(() => writeJobSummary([{ version: '7.1.2', package: 'solidbunch/wordpress-core', lastModified: undefined }]));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^SUMMARY-FAILED: /);
  } finally {
    console.warn = originalWarn;
    delete process.env.GITHUB_STEP_SUMMARY;
  }
});

// packages.json entries never gain a timestamp: verifyArchive surfaces lastModified as a sibling of
// {ok, bytes}, never inside anything that flows into buildEntry's output (extended in
// test/generator-build-entry.test.js and covered end-to-end by the --check invariants).
test('verifyArchive: a present archive Last-Modified is surfaced on the result, absent when there is none', async () => {
  const archive = Buffer.from('fixture archive for the summary test');
  const sha1Hex = createHash('sha1').update(archive).digest('hex');
  const { url, close } = await startServer({
    '/with-header.zip': (req, res) => {
      res.writeHead(200, { 'last-modified': 'Fri, 19 Sep 2026 09:12:04 GMT' });
      res.end(archive);
    },
    '/without-header.zip': (req, res) => {
      res.writeHead(200);
      res.end(archive);
    }
    // no .md5 routes for either: answers 404, exercising the noMd5 path
  });
  try {
    const withHeader = await verifyArchive(`${url}/with-header.zip`, sha1Hex, 2);
    assert.deepEqual(withHeader, { ok: true, bytes: archive.length, lastModified: 'Fri, 19 Sep 2026 09:12:04 GMT', noMd5: true });

    const withoutHeader = await verifyArchive(`${url}/without-header.zip`, sha1Hex, 2);
    assert.deepEqual(withoutHeader, { ok: true, bytes: archive.length, noMd5: true });
    assert.equal(Object.hasOwn(withoutHeader, 'lastModified'), false);
  } finally {
    await close();
  }
});

test('buildEntry: the emitted entry never carries a lastModified/timestamp field', () => {
  const variant = { name: 'solidbunch/wordpress-core', suffix: '', description: 'd', keywords: ['k'], hasSource: true };
  const fields = { name: variant.name, version: '9.9', type: 'wordpress-core', require: { php: '>=7.4' }, distType: 'zip', extra: undefined };
  const entry = buildEntry(variant, fields, 'https://downloads.wordpress.org/release/wordpress-9.9.zip', 'a'.repeat(40));
  assert.equal(Object.hasOwn(entry, 'lastModified'), false);
  assert.equal(JSON.stringify(entry).includes('lastModified'), false);
});
