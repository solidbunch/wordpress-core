'use strict';

const { REQUEST_TIMEOUT_MS } = require('./constants');
const { sleep } = require('./util');

const MAX_IN_FLIGHT = 6;
const MAX_BACKOFF_MS = 30000;

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
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { error: describeError(err) };
  } finally {
    releaseSlot();
  }
}

const describeResponse = (res) => `HTTP ${res.status}: ${res.body.trim().replace(/\s+/g, ' ').slice(0, 500)}`;

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

module.exports = { MAX_IN_FLIGHT, httpGet, describeResponse, withRetries };
