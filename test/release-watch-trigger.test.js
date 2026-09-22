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

function makeRun(startedAt, overrides = {}) {
  return {
    conclusion: 'success',
    head_branch: 'main',
    created_at: startedAt,
    run_started_at: startedAt,
    updated_at: startedAt,
    ...overrides,
  };
}

function runsResponse(...runs) {
  return async () => Response.json({ workflow_runs: runs });
}

test('buildBadge reports the age of the last successful run, green when fresh', async () => {
  const { buildBadge } = await import(WORKER_URL);
  const badge = await buildBadge(ENV, runsResponse(makeRun('2026-09-21T11:53:00Z')), NOW);

  assert.deepEqual(badge, {
    schemaVersion: 1,
    label: 'last release check',
    message: '7 min ago',
    color: 'brightgreen',
  });
});

test('buildBadge turns yellow after 30 minutes and red after 2 hours', async () => {
  const { buildBadge } = await import(WORKER_URL);

  const yellow = await buildBadge(ENV, runsResponse(makeRun('2026-09-21T11:00:00Z')), NOW);
  assert.equal(yellow.color, 'yellow');
  assert.equal(yellow.message, '1 h ago');

  const red = await buildBadge(ENV, runsResponse(makeRun('2026-09-21T08:30:00Z')), NOW);
  assert.equal(red.color, 'red');
  assert.equal(red.message, '3 h ago');
});

test('buildBadge asks for an unfiltered run list and bypasses the subrequest cache', async () => {
  const { buildBadge } = await import(WORKER_URL);
  let requested;
  let init;
  await buildBadge(
    ENV,
    async (url, options) => {
      requested = url;
      init = options;
      return Response.json({ workflow_runs: [] });
    },
    NOW,
  );

  // `status` and `branch` are served by the Actions search index, which can lag by weeks; the
  // unfiltered list is read from the run table instead and matched in the Worker.
  assert.equal(
    requested,
    'https://api.github.com/repos/solidbunch/wordpress-core/actions/workflows/update-packages.yml/runs?per_page=30',
  );
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.Authorization, 'Bearer test-token');
});

test('buildBadge ignores failed runs and runs on other branches', async () => {
  const { buildBadge } = await import(WORKER_URL);
  const badge = await buildBadge(
    ENV,
    runsResponse(
      makeRun('2026-09-21T11:58:00Z', { conclusion: 'failure' }),
      makeRun('2026-09-21T11:57:00Z', { conclusion: null, status: 'in_progress' }),
      makeRun('2026-09-21T11:56:00Z', { head_branch: 'feature' }),
      makeRun('2026-09-21T11:45:00Z'),
    ),
    NOW,
  );

  assert.equal(badge.message, '15 min ago');
  assert.equal(badge.color, 'brightgreen');
});

test('buildBadge picks the newest run even when the API returns them out of order', async () => {
  const { buildBadge } = await import(WORKER_URL);
  const badge = await buildBadge(
    ENV,
    runsResponse(
      makeRun('2026-08-25T03:47:38Z'),
      makeRun('2026-09-21T11:55:00Z'),
      makeRun('2026-09-01T10:38:33Z'),
    ),
    NOW,
  );

  assert.equal(badge.message, '5 min ago');
  assert.equal(badge.color, 'brightgreen');
});

test('buildBadge stays red when retention bumps updated_at on a long-abandoned run', async () => {
  const { buildBadge } = await import(WORKER_URL);
  // GitHub touches a run record 400 days after it was created, so `updated_at` on an ancient run
  // can look like yesterday. Reading it would paint the badge green while the watch is dead.
  const badge = await buildBadge(
    ENV,
    runsResponse(makeRun('2025-08-14T03:51:14Z', { updated_at: '2026-09-20T03:54:59Z' })),
    NOW,
  );

  assert.equal(badge.message, '403 d ago');
  assert.equal(badge.color, 'red');
});

test('buildBadge falls back to created_at when a run has no run_started_at', async () => {
  const { buildBadge } = await import(WORKER_URL);
  const run = makeRun('2026-09-21T11:53:00Z');
  delete run.run_started_at;

  const badge = await buildBadge(ENV, runsResponse(run), NOW);

  assert.equal(badge.message, '7 min ago');
});

test('buildBadge is red when there is no successful run and greyed out when the API fails', async () => {
  const { buildBadge } = await import(WORKER_URL);

  const none = await buildBadge(ENV, runsResponse(), NOW);
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
  globalThis.fetch = runsResponse(makeRun(new Date().toISOString()));
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
