// Cloudflare Worker for the "WordPress release watch" workflow.
//
// scheduled: cron trigger that starts the workflow in light mode. GitHub's own `schedule` event is
//   best-effort and can lag by hours; `workflow_dispatch` is not queued behind it, so an external
//   scheduler gives a dependable check cadence.
// fetch: GET /badge.json serves a shields.io endpoint badge with the age of the last successful
//   workflow run. The time comes from the GitHub API, so the Worker keeps no state of its own and
//   the badge turns red on its own if the runs stop arriving.

const GITHUB_API = 'https://api.github.com';
const FRESH_MS = 30 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const RUNS_PER_PAGE = 30;

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wordpress-core-release-watch-trigger',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function dispatchReleaseCheck(env, fetchImpl = fetch) {
  const url = `${GITHUB_API}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { mode: 'light' } }),
  });
  if (response.status !== 204) {
    throw new Error(`workflow dispatch failed: HTTP ${response.status} ${await response.text()}`);
  }
}

export function formatAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// The newest successful run on the watched branch, by start time.
//
// `status` and `branch` are not passed to the API as query filters: those are served by the Actions
// search index, which can fall weeks behind and then return an ancient run as the first result. The
// unfiltered list comes from the run table itself, so the conclusion and branch are matched here.
//
// Ordering is by `created_at`, never `updated_at`: GitHub's retention touches a run record 400 days
// after it was created, which would make a long-abandoned run look like a fresh check.
export function selectLatestRun(runs, branch) {
  return runs
    .filter((run) => run.conclusion === 'success' && run.head_branch === branch)
    .reduce(
      (newest, run) =>
        newest && Date.parse(newest.created_at) >= Date.parse(run.created_at) ? newest : run,
      null,
    );
}

export async function buildBadge(env, fetchImpl = fetch, now = Date.now()) {
  const label = 'last release check';
  const url =
    `${GITHUB_API}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.WORKFLOW_FILE}/runs` +
    `?per_page=${RUNS_PER_PAGE}`;
  // `no-store` keeps the Cloudflare subrequest cache out of the freshness calculation.
  const response = await fetchImpl(url, { headers: githubHeaders(env), cache: 'no-store' });
  if (!response.ok) {
    return { schemaVersion: 1, label, message: 'unavailable', color: 'lightgrey', isError: true };
  }
  const run = selectLatestRun((await response.json()).workflow_runs ?? [], env.GITHUB_REF);
  if (!run) return { schemaVersion: 1, label, message: 'no successful run', color: 'red' };

  const age = Math.max(0, now - Date.parse(run.run_started_at ?? run.created_at));
  const color = age <= FRESH_MS ? 'brightgreen' : age <= STALE_MS ? 'yellow' : 'red';
  return { schemaVersion: 1, label, message: formatAge(age), color };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchReleaseCheck(env));
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/badge.json') return new Response('Not found', { status: 404 });
    return Response.json(await buildBadge(env), { headers: { 'Cache-Control': 'public, max-age=60' } });
  },
};
