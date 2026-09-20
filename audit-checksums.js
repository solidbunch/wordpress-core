'use strict';

const fs = require('fs');

const { VARIANTS, SHASUM_RE, probeBase } = require('./lib/constants');
const { httpGet, describeResponse, withRetries } = require('./lib/http');
const { readPackagesFile } = require('./lib/packages-file');

// PACKAGES_FILE is a test seam here (unlike generate-packages-json.js's own constant); the
// workflow never sets it, it always audits the checked-out packages.json.
const PACKAGES_FILE = process.env.PACKAGES_FILE || 'packages.json';

const AUDIT_RETRIES = 3;

const pluralize = (n, singular, plural) => (n === 1 ? singular : plural);

// Uses probeBase() (the DOWNLOAD_BASE_OVERRIDE-aware seam from lib/constants), never the canonical
// DOWNLOAD_BASE directly, so tests can point this at a local server without touching production URLs.
const distSha1Url = (variant, version) => `${probeBase()}wordpress-${version}${variant.suffix}.zip.sha1`;

// Re-fetches the published .sha1 for one stored entry and compares it with dist.shasum.
// Never writes to packages.json. A 404 is terminal ("missing"); every other failure is retried
// through withRetries and, on exhaustion, reported as "unreachable" rather than a mismatch.
async function auditEntry(variant, version, storedShasum) {
  const url = distSha1Url(variant, version);
  const outcome = await withRetries(async () => {
    const res = await httpGet(url);
    if (res.error) return { retry: res.error };
    if (res.status === 404) return { missing: true };
    if (res.status !== 200) return { retry: describeResponse(res) };
    const published = res.body.trim();
    if (!SHASUM_RE.test(published)) return { retry: `HTTP 200 but body is not a SHA-1: ${JSON.stringify(published.slice(0, 100))}` };
    return { published };
  }, { retries: AUDIT_RETRIES });

  if (outcome.missing) return { status: 'missing', url };
  if (outcome.failure) return { status: 'unreachable', reason: `${outcome.failure} (after ${AUDIT_RETRIES} retries)` };
  if (outcome.published !== storedShasum) return { status: 'mismatch', published: outcome.published };
  return { status: 'ok' };
}

async function main() {
  const packages = readPackagesFile(PACKAGES_FILE, { required: true });
  const entries = [];
  for (const variant of VARIANTS) {
    const versions = packages[variant.name] || {};
    for (const version of Object.keys(versions)) {
      entries.push({ variant, version, storedShasum: versions[version]?.dist?.shasum });
    }
  }

  // Concurrency is already bounded by lib/http.js's own acquireSlot/releaseSlot limiter
  // (MAX_IN_FLIGHT = 6), so firing off every entry at once here does not run 1342 requests unbounded.
  const results = await Promise.all(entries.map(({ variant, version, storedShasum }) => auditEntry(variant, version, storedShasum)));

  const verbose = process.env.AUDIT_VERBOSE === 'true';
  let mismatches = 0;
  let missing = 0;
  let unreachable = 0;

  results.forEach((result, i) => {
    const { variant, version, storedShasum } = entries[i];
    const label = `${variant.name} ${version}`;
    if (result.status === 'ok') {
      if (verbose) console.log(`OK: ${label}`);
    } else if (result.status === 'mismatch') {
      mismatches++;
      console.log(`MISMATCH: ${label}: stored ${storedShasum}, published ${result.published}`);
    } else if (result.status === 'missing') {
      missing++;
      console.log(`MISSING: ${label}: ${result.url} returned 404`);
    } else {
      unreachable++;
      console.log(`UNREACHABLE: ${label}: ${result.reason}`);
    }
  });

  const total = entries.length;
  const summary = `AUDITED ${total} ${pluralize(total, 'entry', 'entries')}: ${mismatches} ${pluralize(mismatches, 'mismatch', 'mismatches')}, ${missing} missing, ${unreachable} unreachable`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  // Exit policy: a mismatch or a missing archive is never a false alarm and always fails the run.
  if (mismatches > 0 || missing > 0) {
    process.exitCode = 1;
    return;
  }
  // A handful of unreachable entries is treated as transient network noise, not a real failure.
  // But once more than 10% of the file could not be reached, the audit itself is inconclusive.
  if (unreachable > total / 10) {
    console.log(`AUDIT-INCONCLUSIVE: ${unreachable} of ${total} entries unreachable, exceeding the 10% threshold`);
    process.exitCode = 1;
    return;
  }
  if (unreachable > 0) {
    console.warn(`WARNING: ${unreachable} ${pluralize(unreachable, 'entry is', 'entries are')} unreachable; treated as a transient network issue`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { auditEntry, main };
