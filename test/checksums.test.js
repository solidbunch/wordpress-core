'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { sha1, md5, MD5_RE } = require('../lib/checksums');
const { httpGetBuffer, MAX_ARCHIVE_BYTES } = require('../lib/http');
const { verifyArchive } = require('../generate-packages-json');
const { startServer } = require('./helpers');

// Known vectors, independent of the local server fixtures below.
test('sha1 of the empty buffer matches the known vector', () => {
  assert.equal(sha1(Buffer.alloc(0)), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
});

test('md5 of the empty buffer matches the known vector', () => {
  assert.equal(md5(Buffer.alloc(0)), 'd41d8cd98f00b204e9800998ecf8427e');
});

test('MD5_RE matches 32 lowercase hex characters only', () => {
  assert.equal(MD5_RE.test('d41d8cd98f00b204e9800998ecf8427e'), true);
  assert.equal(MD5_RE.test('D41D8CD98F00B204E9800998ECF8427E'), false);
  assert.equal(MD5_RE.test('not-hex'), false);
});

const ARCHIVE = Buffer.from('this is a fake wordpress archive for offline tests');
const ARCHIVE_SHA1 = createHash('sha1').update(ARCHIVE).digest('hex');
const ARCHIVE_MD5 = createHash('md5').update(ARCHIVE).digest('hex');

function archiveRoute(req, res) {
  res.writeHead(200, { 'content-type': 'application/zip' });
  res.end(ARCHIVE);
}

test('verifyArchive: matching SHA-1 and MD5 succeeds with no noMd5 flag', async () => {
  const { url, close } = await startServer({
    '/wordpress.zip': archiveRoute,
    '/wordpress.zip.md5': (req, res) => {
      res.writeHead(200);
      res.end(ARCHIVE_MD5);
    }
  });
  try {
    const result = await verifyArchive(`${url}/wordpress.zip`, ARCHIVE_SHA1, 2);
    assert.deepEqual(result, { ok: true, bytes: ARCHIVE.length });
  } finally {
    await close();
  }
});

test('verifyArchive: SHA-1 mismatch defers with the published and computed hashes', async () => {
  const { url, close } = await startServer({
    '/wordpress.zip': archiveRoute,
    '/wordpress.zip.md5': (req, res) => {
      res.writeHead(200);
      res.end(ARCHIVE_MD5);
    }
  });
  try {
    const wrongSha1 = 'a'.repeat(40);
    const result = await verifyArchive(`${url}/wordpress.zip`, wrongSha1, 2);
    assert.deepEqual(result, { ok: false, mismatch: 'sha1', expected: wrongSha1, actual: ARCHIVE_SHA1 });
  } finally {
    await close();
  }
});

test('verifyArchive: SHA-1 matches but MD5 does not', async () => {
  const { url, close } = await startServer({
    '/wordpress.zip': archiveRoute,
    '/wordpress.zip.md5': (req, res) => {
      res.writeHead(200);
      res.end('b'.repeat(32));
    }
  });
  try {
    const result = await verifyArchive(`${url}/wordpress.zip`, ARCHIVE_SHA1, 2);
    assert.deepEqual(result, { ok: false, mismatch: 'md5', expected: 'b'.repeat(32), actual: ARCHIVE_MD5 });
  } finally {
    await close();
  }
});

test('verifyArchive: a missing .md5 (404) is not a failure', async () => {
  const { url, close } = await startServer({
    '/wordpress.zip': archiveRoute
    // no route for .md5: startServer answers 404 by default
  });
  try {
    const result = await verifyArchive(`${url}/wordpress.zip`, ARCHIVE_SHA1, 2);
    assert.deepEqual(result, { ok: true, bytes: ARCHIVE.length, noMd5: true });
  } finally {
    await close();
  }
});

test('verifyArchive: the archive route failing on every attempt is a transient failure', { timeout: 10000 }, async () => {
  const { url, close } = await startServer({
    '/wordpress.zip': (req, res) => {
      res.writeHead(500);
      res.end('boom');
    }
  });
  try {
    const result = await verifyArchive(`${url}/wordpress.zip`, ARCHIVE_SHA1, 2);
    assert.equal(typeof result.failure, 'string');
    assert.match(result.failure, /HTTP 500/);
  } finally {
    await close();
  }
});

// Critic's accepted-risk note: the cap must not rely only on a declared content-length, because a
// chunked (no content-length) response could otherwise exhaust memory while being buffered.

test('httpGetBuffer: a declared content-length above the cap is rejected without downloading the body', async () => {
  const { url, close } = await startServer({
    '/big.zip': (req, res) => {
      res.writeHead(200, { 'content-length': String(MAX_ARCHIVE_BYTES + 1) });
      res.end(Buffer.from('short body, the header lies about the real length'));
    }
  });
  try {
    const result = await httpGetBuffer(`${url}/big.zip`);
    assert.deepEqual(result, { error: 'archive larger than 200 MiB' });
  } finally {
    await close();
  }
});

test('httpGetBuffer: a chunked response with no content-length is still rejected by the running total', { timeout: 30000 }, async () => {
  const chunk = Buffer.alloc(4 * 1024 * 1024, 'a'); // 4 MiB
  const chunksToExceedCap = Math.ceil((MAX_ARCHIVE_BYTES + chunk.length) / chunk.length);
  const { url, close } = await startServer({
    '/big.zip': (req, res) => {
      res.writeHead(200); // no content-length header -> Node sends this chunked
      let sent = 0;
      const writeNext = () => {
        if (sent++ >= chunksToExceedCap || res.destroyed) {
          res.end();
          return;
        }
        if (res.write(chunk)) setImmediate(writeNext);
        else res.once('drain', writeNext);
      };
      writeNext();
    }
  });
  try {
    const result = await httpGetBuffer(`${url}/big.zip`);
    assert.deepEqual(result, { error: 'archive larger than 200 MiB' });
  } finally {
    await close();
  }
});
