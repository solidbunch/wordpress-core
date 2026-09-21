// Cloudflare cron trigger that starts the "WordPress release watch" workflow in light mode.
// GitHub's own `schedule` event is best-effort and can lag by hours; `workflow_dispatch` is not
// queued behind it, so an external scheduler gives a dependable check cadence.

const GITHUB_API = 'https://api.github.com';

export async function dispatchReleaseCheck(env, fetchImpl = fetch) {
  const url = `${GITHUB_API}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'wordpress-core-release-watch-trigger',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { mode: 'light' } }),
  });
  if (response.status !== 204) {
    throw new Error(`workflow dispatch failed: HTTP ${response.status} ${await response.text()}`);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchReleaseCheck(env));
  },
};
