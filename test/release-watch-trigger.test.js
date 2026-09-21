'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const WORKER_URL = pathToFileURL(path.join(__dirname, '..', 'cloudflare-worker', 'worker.mjs')).href;

const ENV = {
  GITHUB_REPOSITORY: 'solidbunch/wordpress-core',
  GITHUB_REF: 'main',
  WORKFLOW_FILE: 'update-packages.yml',
  GITHUB_TOKEN: 'test-token',
};

test('dispatchReleaseCheck posts a light-mode workflow_dispatch to the workflow', async () => {
  const { dispatchReleaseCheck } = await import(WORKER_URL);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  };

  await dispatchReleaseCheck(ENV, fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.github.com/repos/solidbunch/wordpress-core/actions/workflows/update-packages.yml/dispatches',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main', inputs: { mode: 'light' } });
});

test('dispatchReleaseCheck rejects on a non-204 response', async () => {
  const { dispatchReleaseCheck } = await import(WORKER_URL);
  const fetchImpl = async () => new Response('Bad credentials', { status: 401 });

  await assert.rejects(dispatchReleaseCheck(ENV, fetchImpl), /HTTP 401 Bad credentials/);
});

test('scheduled handler hands the dispatch to waitUntil', async () => {
  const worker = (await import(WORKER_URL)).default;
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(null, { status: 204 });
  };
  const pending = [];
  try {
    await worker.scheduled({}, ENV, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(pending.length, 1);
  assert.equal(requests.length, 1);
});
