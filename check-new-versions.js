'use strict';

const fs = require('fs');

const { VARIANTS, ANY_VERSION_RE, SHASUM_RE, probeBase, betaChannelUrl } = require('./lib/constants');
const { isObject } = require('./lib/util');
const { httpGet, withRetries } = require('./lib/http');

// Test seams: the workflow never sets these
const PACKAGES_FILE = process.env.PACKAGES_FILE || 'packages.json';
const VERSION_CHECK_URL = process.env.VERSION_CHECK_URL || 'https://api.wordpress.org/core/version-check/1.7/';

const BACKOFF_MS = [2000, 6000];

// Keeps this gate's original, shorter failure-reason formula (no err.cause?.message fallback)
// byte-identical to HEAD; see lib/http.js's defaultDescribeError for the generator's formula.
const describeError = (err) => err.cause?.code || err.message;

// judge(status, body) returns a verdict object, or { retry: reason } for a transient failure
async function get(url, judge) {
  const outcome = await withRetries(async () => {
    const res = await httpGet(url, { describeError });
    if (res.error) return { retry: res.error };
    return judge(res.status, res.body);
  }, { retries: BACKOFF_MS.length, delayFor: (i) => BACKOFF_MS[i - 1] });
  if (outcome.failure) throw new Error(`cannot fetch ${url}: ${outcome.failure} (after ${BACKOFF_MS.length + 1} attempts)`);
  return outcome;
}

function readPackages() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PACKAGES_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${PACKAGES_FILE}: ${err.message}`);
  }
  const expected = VARIANTS.map((variant) => variant.name).sort();
  if (!isObject(parsed) || !isObject(parsed.packages) || JSON.stringify(Object.keys(parsed.packages).sort()) !== JSON.stringify(expected)) {
    throw new Error(`${PACKAGES_FILE} must hold exactly the packages ${expected.join(', ')}`);
  }
  for (const name of expected) {
    if (!isObject(parsed.packages[name])) throw new Error(`${PACKAGES_FILE}: package ${name} is not an object`);
  }
  return parsed.packages;
}

// Never throws: the beta channel is advisory only (plan Design decision 7). Any failure - network,
// non-200, unparseable body, missing "offers" array - logs BETA-CHANNEL-UNAVAILABLE and yields no offers.
async function fetchBetaOffers() {
  const url = betaChannelUrl(VERSION_CHECK_URL);
  try {
    const { body } = await get(url, (status, text) => (status === 200 ? { body: text } : { retry: `HTTP ${status}` }));
    let offers;
    try {
      offers = JSON.parse(body).offers;
    } catch (err) {
      console.log(`BETA-CHANNEL-UNAVAILABLE: cannot parse response of ${url}: ${err.name}`);
      return [];
    }
    if (!Array.isArray(offers)) {
      console.log(`BETA-CHANNEL-UNAVAILABLE: ${url} returned no "offers" array`);
      return [];
    }
    return offers;
  } catch (err) {
    console.log(`BETA-CHANNEL-UNAVAILABLE: ${err.message}`);
    return [];
  }
}

async function fetchOfferedVersions() {
  const { body } = await get(VERSION_CHECK_URL, (status, text) => (status === 200 ? { body: text } : { retry: `HTTP ${status}` }));
  let offers;
  try {
    offers = JSON.parse(body).offers;
  } catch (err) {
    throw new Error(`cannot parse response of ${VERSION_CHECK_URL}: ${err.name}`);
  }
  if (!Array.isArray(offers)) throw new Error(`${VERSION_CHECK_URL} returned no "offers" array`);
  const betaOffers = await fetchBetaOffers();
  const versions = new Set();
  for (const offer of [...offers, ...betaOffers]) {
    const version = offer?.version;
    if (typeof version === 'string' && ANY_VERSION_RE.test(version)) versions.add(version);
    else console.log(`IGNORED-VERSION: ${JSON.stringify(version)} (from offers)`);
  }
  if (versions.size === 0) throw new Error(`${VERSION_CHECK_URL} offers no usable version`);
  return versions;
}

function judgeProbe(status, body) {
  if (status === 404) return { exists: false };
  if (status === 200 && SHASUM_RE.test(body.trim())) return { exists: true };
  return { retry: `HTTP ${status}` };
}

function finish(run, reason) {
  console.log(reason);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

async function main() {
  if (process.env.FORCE_FULL === 'true') return finish(true, 'FORCE_FULL=true: skipping the release check');

  const packages = readPackages();
  const offered = await fetchOfferedVersions();
  const missing = [];
  for (const version of offered) {
    for (const variant of VARIANTS) {
      if (!Object.hasOwn(packages[variant.name], version)) missing.push({ variant, version });
    }
  }
  if (missing.length === 0) return finish(false, `All ${offered.size} offered version(s) are in ${PACKAGES_FILE}`);

  for (const { variant, version } of missing) {
    const url = `${probeBase()}wordpress-${version}${variant.suffix}.zip.sha1`;
    if ((await get(url, judgeProbe)).exists) return finish(true, `${variant.name} ${version} is offered, missing and its archive exists`);
    console.log(`SKIPPED-NO-ARCHIVE: ${variant.name} ${version}: ${url} returned 404`);
  }
  return finish(false, `${missing.length} offered package version(s) have no archive yet`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, readPackages, fetchOfferedVersions, fetchBetaOffers, judgeProbe };
