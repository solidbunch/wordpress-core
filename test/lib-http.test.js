'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { httpGet } = require('../lib/http');

// http://127.0.0.1:1 fails immediately with ERR_SOCKET_BAD_PORT, no network I/O involved.
const BAD_PORT_URL = 'http://127.0.0.1:1';

test('httpGet default describeError falls back through err.cause?.message', async () => {
  const res = await httpGet(BAD_PORT_URL);
  assert.equal(res.error, 'bad port');
});

test('httpGet accepts a describeError option for callers that keep their own formula', async () => {
  const describeError = (err) => err.cause?.code || err.message;
  const res = await httpGet(BAD_PORT_URL, { describeError });
  assert.equal(res.error, 'fetch failed');
});
