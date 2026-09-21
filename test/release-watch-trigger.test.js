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

const NOW = Date.parse('2026-09-21T12:00:00Z');

function runsResponse(updatedAt) {
  const workflowRuns = updatedAt ? [{ updated_at: updatedAt }] : [];
  return async () => Response.json({ workflow_runs: workflowRuns });
}

test('buildBadge reports the age of the last successful run, green when fresh', async () => {
  const { buildBadge } = await import(WORKER_URL);
  const badge = await buildBadge(ENV, runsResponse('2026-09-21T11:53:00Z'), NOW);

  assert.deepEqual(badge, {
    schemaVersion: 1,
    label: 'last release check',
    message: '7 min ago',
    color: 'brightgreen',
  });
});

test('buildBadge turns yellow after 30 minutes and red after 2 hours', async () => {
  const { buildBadge } = await import(WORKER_URL);

  const yellow = await buildBadge(ENV, runsResponse('2026-09-21T11:00:00Z'), NOW);
  assert.equal(yellow.color, 'yellow');
  assert.equal(yellow.message, '1 h ago');

  const red = await buildBadge(ENV, runsResponse('2026-09-21T08:30:00Z'), NOW);
  assert.equal(red.color, 'red');
  assert.equal(red.message, '3 h ago');
});

test('buildBadge queries successful runs of the configured workflow and branch', async () => {
  const { buildBadge } = await import(WORKER_URL);
  let requested;
  await buildBadge(ENV, async (url) => {
    requested = url;
    return Response.json({ workflow_runs: [] });
  }, NOW);

  assert.equal(
    requested,
    'https://api.github.com/repos/solidbunch/wordpress-core/actions/workflows/update-packages.yml/runs?status=success&branch=main&per_page=1',
  );
});

test('buildBadge is red when there is no successful run and greyed out when the API fails', async () => {
  const { buildBadge } = await import(WORKER_URL);

  const none = await buildBadge(ENV, runsResponse(null), NOW);
  assert.equal(none.message, 'no successful run');
  assert.equal(none.color, 'red');

  const failed = await buildBadge(ENV, async () => new Response('boom', { status: 502 }), NOW);
  assert.equal(failed.message, 'unavailable');
  assert.equal(failed.isError, true);
});

test('formatAge rounds down and switches units', async () => {
  const { formatAge } = await import(WORKER_URL);

  assert.equal(formatAge(30 * 1000), 'just now');
  assert.equal(formatAge(59 * 60 * 1000 + 59000), '59 min ago');
  assert.equal(formatAge(5 * 60 * 60 * 1000), '5 h ago');
  assert.equal(formatAge(50 * 60 * 60 * 1000), '2 d ago');
});

test('fetch handler serves /badge.json with a short cache and 404s elsewhere', async () => {
  const worker = (await import(WORKER_URL)).default;
  const original = globalThis.fetch;
  globalThis.fetch = runsResponse(new Date().toISOString());
  try {
    const ok = await worker.fetch(new Request('https://example.workers.dev/badge.json'), ENV);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Cache-Control'), 'public, max-age=60');
    assert.equal((await ok.json()).color, 'brightgreen');

    const missing = await worker.fetch(new Request('https://example.workers.dev/'), ENV);
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = original;
  }
});
