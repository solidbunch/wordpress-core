'use strict';

const { REQUEST_TIMEOUT_MS } = require('./constants');
const { sleep } = require('./util');

const MAX_IN_FLIGHT = 6;
const MAX_BACKOFF_MS = 30000;

// 200 MiB is comfortably above the largest published WordPress core archive. Enforced twice: once
// from a declared content-length (cheap, avoids starting a doomed download) and again as a running
// total while the body streams in, because content-length is absent for chunked responses and is
// otherwise just a claim from the server, not a guarantee.
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const ARCHIVE_TOO_LARGE = 'archive larger than 200 MiB';

let inFlight = 0;
const waiting = [];

async function acquireSlot() {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}

// describeError is a parameter (not hard-coded) because the two callers keep their pre-extraction,
// byte-identical error messages: the generator falls back to err.cause?.message, the gate does not.
const defaultDescribeError = (err) => err.cause?.code || err.cause?.message || err.message;

async function httpGet(url, { describeError = defaultDescribeError } = {}) {
  await acquireSlot();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: res.status, body: await res.text(), headers: { 'last-modified': res.headers.get('last-modified') } };
  } catch (err) {
    return { error: describeError(err) };
  } finally {
    releaseSlot();
  }
}

const describeResponse = (res) => `HTTP ${res.status}: ${res.body.trim().replace(/\s+/g, ' ').slice(0, 500)}`;

// Streams the response body instead of relying on res.text()/res.arrayBuffer() so the running-total
// cap below can abort a chunked (no content-length) response before it is fully buffered.
async function httpGetBuffer(url, { describeError = defaultDescribeError } = {}) {
  await acquireSlot();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const headers = {
      'content-length': res.headers.get('content-length'),
      'last-modified': res.headers.get('last-modified')
    };
    const declaredLength = Number(headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      if (res.body) await res.body.cancel();
      return { error: ARCHIVE_TOO_LARGE };
    }
    if (!res.body) return { status: res.status, buffer: Buffer.alloc(0), headers };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        return { error: ARCHIVE_TOO_LARGE };
      }
      chunks.push(value);
    }
    return { status: res.status, buffer: Buffer.concat(chunks), headers };
  } catch (err) {
    return { error: describeError(err) };
  } finally {
    releaseSlot();
  }
}

const defaultDelayFor = (i) => Math.min(1000 * 2 ** (i - 1), MAX_BACKOFF_MS);

// attempt() returns an outcome; an outcome with a truthy .retry is retried, anything else is returned.
// After `retries` retries are exhausted, { failure: <last retry reason> } is returned.
async function withRetries(attempt, { retries, delayFor = defaultDelayFor } = {}) {
  let reason;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(delayFor(i));
    const outcome = await attempt();
    if (!outcome.retry) return outcome;
    reason = outcome.retry;
  }
  return { failure: reason };
}

module.exports = { MAX_IN_FLIGHT, MAX_ARCHIVE_BYTES, httpGet, httpGetBuffer, describeResponse, withRetries };
