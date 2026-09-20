'use strict';

const fs = require('fs');

const { httpGet, describeResponse, withRetries } = require('./lib/http');

// README_FILE is a test seam, mirroring audit-checksums.js's PACKAGES_FILE convention; the
// workflow never sets it, it always validates the checked-out README.md.
const README_FILE = process.env.README_FILE || 'README.md';
const VALIDATE_RETRIES = 2;

const pluralize = (n, singular, plural) => (n === 1 ? singular : plural);

const BADGE_LINE_RE = /^\[!\[([^\]]*)\]\((\S+?)\)\]\((\S+?)\)\s*$/;

// Returns the first maximal run of consecutive badge lines, in README order. Badge-looking lines
// outside that run (e.g. a decoy further down the document, or a blank line splitting the block)
// are deliberately ignored — see the plan's block-scoping rationale.
function parseBadgeBlock(text) {
  const lines = text.split(/\r?\n/);
  const badges = [];
  let started = false;
  for (let i = 0; i < lines.length; i++) {
    const match = BADGE_LINE_RE.exec(lines[i]);
    if (match) {
      started = true;
      badges.push({ alt: match[1], imageUrl: match[2], linkUrl: match[3], line: i + 1 });
    } else if (started) {
      break;
    }
  }
  return badges;
}

// Parses badge.imageUrl to decide how to check it. A malformed URL classifies as 'unknown' rather
// than throwing. targetUrl is the decoded Pages artifact for 'shields', imageUrl itself for
// 'native' (retained for symmetry, same string), and null for 'unknown'.
function classifyBadge(badge) {
  let url;
  try {
    url = new URL(badge.imageUrl);
  } catch {
    return { ...badge, kind: 'unknown', targetUrl: null };
  }
  if (url.host === 'github.com' && /\/actions\/workflows\/[^/]+\/badge\.svg$/.test(url.pathname)) {
    return { ...badge, kind: 'native', targetUrl: badge.imageUrl };
  }
  if (url.host === 'img.shields.io' && url.pathname === '/endpoint') {
    const target = url.searchParams.get('url');
    if (typeof target === 'string' && target.length > 0) {
      return { ...badge, kind: 'shields', targetUrl: target };
    }
  }
  return { ...badge, kind: 'unknown', targetUrl: null };
}

// Null-safe media type. res.headers['content-type'] is null when the header is absent
// (Headers.get returns null), and undefined if a caller hands us a header-less object.
const mediaType = (res) => {
  const raw = res.headers && res.headers['content-type'];
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : null;
};

// native badge image: status + media type only
function checkSvgResponse(res) {
  if (res.status !== 200) return { pass: false, detail: describeResponse(res) };
  const type = mediaType(res);
  if (type !== 'image/svg+xml') {
    return {
      pass: false,
      detail: `HTTP 200 but Content-Type is ${JSON.stringify(res.headers && res.headers['content-type'])}, expected image/svg+xml`
    };
  }
  return { pass: true, detail: '200, image/svg+xml' };
}

// shields badge image: identical pass/fail rule, plus a non-blocking echo of the SVG's <title>,
// which is how a human sees at a glance that shields rendered an error badge ("resource not found")
// rather than the real value. The title NEVER affects pass/fail — shields' markup is not a contract.
function checkShieldsImageResponse(res) {
  const base = checkSvgResponse(res);
  if (!base.pass) return base;
  const title = /<title>([^<]*)<\/title>/.exec(res.body || '');
  return {
    pass: true,
    detail: title ? `200, image/svg+xml, title ${JSON.stringify(title[1].slice(0, 120))}` : '200, image/svg+xml'
  };
}

// Pages artifact: status + shields endpoint-schema validation
function checkEndpointPayload(res) {
  if (res.status !== 200) return { pass: false, detail: describeResponse(res) };
  const snippet = (res.body || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  let payload;
  try {
    payload = JSON.parse(res.body);
  } catch {
    return { pass: false, detail: `HTTP 200 but body is not JSON: ${snippet}` };
  }
  const valid = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    && payload.schemaVersion === 1 && typeof payload.label === 'string'
    && typeof payload.message === 'string' && payload.message.length > 0;
  if (!valid) {
    return {
      pass: false,
      detail: `HTTP 200 but not a shields endpoint payload (schemaVersion/label/message): ${snippet}`
    };
  }
  return { pass: true, detail: `200, schemaVersion 1, "${payload.label}: ${payload.message}"` };
}

// runCheck owns fetch + retry + its own try/catch, so a throw inside one check degrades that
// single check rather than the badge, and never escapes to Promise.all. Transport errors and 5xx
// are retried VALIDATE_RETRIES times; a 4xx is terminal, matching audit-checksums.js's convention.
async function runCheck(name, url, evaluate) {
  try {
    const outcome = await withRetries(async () => {
      const res = await httpGet(url);
      if (res.error) return { retry: res.error };
      if (res.status >= 500) return { retry: describeResponse(res) };
      return { res };
    }, { retries: VALIDATE_RETRIES });
    if (outcome.failure) {
      return { name, url, pass: false, detail: `${outcome.failure} (after ${VALIDATE_RETRIES} retries)` };
    }
    const { pass, detail } = evaluate(outcome.res);
    return { name, url, pass, detail };
  } catch (err) {
    return { name, url, pass: false, detail: `internal error while checking: ${err.message}` };
  }
}

const finish = (classified, checks) => ({ ...classified, checks, ok: checks.every((c) => c.pass) });

// checkBadge never rejects: every path returns a result object, and an unexpected throw is
// converted into a failed result so Promise.all in main() cannot lose the rest of the report.
async function checkBadge(classified) {
  try {
    if (classified.kind === 'unknown') {
      return finish(classified, [{
        name: 'classification', url: classified.imageUrl, pass: false,
        detail: 'unrecognised badge kind; this validator cannot check it'
      }]);
    }
    if (classified.kind === 'native') {
      return finish(classified, [await runCheck('badge-image-check', classified.imageUrl, checkSvgResponse)]);
    }
    // 'shields': both hops, in parallel; each runCheck is itself guarded.
    const [endpointCheck, targetCheck] = await Promise.all([
      runCheck('shields-endpoint-check', classified.imageUrl, checkShieldsImageResponse),
      runCheck('target-artifact-check', classified.targetUrl, checkEndpointPayload)
    ]);
    return finish(classified, [endpointCheck, targetCheck]);
  } catch (err) {
    return finish(classified, [{
      name: 'internal', url: classified.imageUrl, pass: false,
      detail: `internal error while checking: ${err.message}`
    }]);
  }
}

// formatReport prints one header line per badge in README order, then one indented line per
// check, so a shields badge always shows both results and both URLs whatever the outcome.
function formatReport(results) {
  const lines = [];
  let failed = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  for (const result of results) {
    if (result.ok) {
      lines.push(`OK: ${result.alt} [${result.kind}] ${result.imageUrl}`);
    } else {
      failed++;
      lines.push(`FAIL: ${result.alt} [${result.kind}] line ${result.line}: ${result.imageUrl}`);
    }
    for (const check of result.checks) {
      if (check.pass) passedChecks++;
      else failedChecks++;
      lines.push(`  ${check.name}: ${check.pass ? 'PASS' : 'FAIL'} ${check.url} — ${check.detail}`);
    }
  }
  const total = results.length;
  const ok = total - failed;
  const totalChecks = passedChecks + failedChecks;
  const summary = `CHECKED ${total} ${pluralize(total, 'badge', 'badges')}: ${ok} ok, ${failed} failed `
    + `(${totalChecks} ${pluralize(totalChecks, 'check', 'checks')}: ${passedChecks} passed, ${failedChecks} failed)`;
  return { lines, summary, failed };
}

async function main() {
  const text = fs.readFileSync(README_FILE, 'utf8');
  const badges = parseBadgeBlock(text);
  if (badges.length === 0) {
    console.error(`FATAL: no badge block found in ${README_FILE}`);
    process.exitCode = 1;
    return;
  }
  const classified = badges.map(classifyBadge);
  const results = await Promise.all(classified.map(checkBadge));
  const { lines, summary, failed } = formatReport(results);
  for (const line of lines) console.log(line);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseBadgeBlock, classifyBadge, checkBadge, formatReport, main };
