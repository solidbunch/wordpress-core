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

export async function buildBadge(env, fetchImpl = fetch, now = Date.now()) {
  const label = 'last release check';
  const url =
    `${GITHUB_API}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.WORKFLOW_FILE}/runs` +
    `?status=success&branch=${encodeURIComponent(env.GITHUB_REF)}&per_page=1`;
  const response = await fetchImpl(url, { headers: githubHeaders(env) });
  if (!response.ok) {
    return { schemaVersion: 1, label, message: 'unavailable', color: 'lightgrey', isError: true };
  }
  const [run] = (await response.json()).workflow_runs;
  if (!run) return { schemaVersion: 1, label, message: 'no successful run', color: 'red' };

  const age = Math.max(0, now - Date.parse(run.updated_at));
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
