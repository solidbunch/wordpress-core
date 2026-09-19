'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const PACKAGES_FILE = 'packages.json';
const API_URL = 'https://api.wordpress.org/core/version-check/1.7/';
const STABLE_CHECK_URL = 'https://api.wordpress.org/core/stable-check/1.0/';
const VERSION_PHP_URLS = [
  (version) => `https://core.svn.wordpress.org/tags/${version}/wp-includes/version.php`,
  (version) => `https://raw.githubusercontent.com/WordPress/WordPress/${version}/wp-includes/version.php`
];
const DOWNLOAD_BASE = 'https://downloads.wordpress.org/release/';
const DOWNLOAD_HOST = 'downloads.wordpress.org';

// Oldest branch ever published here; limits enumeration only
const MIN_VERSION = '4.1';

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const SHASUM_RE = /^[0-9a-f]{40}$/;
const PHP_REQUIREMENT_RE = /^>=\d+\.\d+$/;

const REQUEST_TIMEOUT_MS = 15000;
const MAX_IN_FLIGHT = 6;
const MAX_BACKOFF_MS = 30000;
const API_RETRIES = 2;
const NEW_ENTRY_RETRIES = 2;
const EXISTING_ENTRY_RETRIES = 5;

const VARIANTS = [
  { name: 'solidbunch/wordpress-core-no-content', suffix: '-no-content' },
  { name: 'solidbunch/wordpress-core', suffix: '' }
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const distUrl = (variant, version) => `${DOWNLOAD_BASE}wordpress-${version}${variant.suffix}.zip`;

function versionParts(version) {
  const parts = version.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// "4.1" and "4.1.0" are the same Composer version, so equal-comparing keys are duplicates
function findDuplicates(versions) {
  const seen = new Map();
  const duplicates = [];
  for (const version of versions) {
    const canonical = versionParts(version).join('.');
    if (seen.has(canonical)) duplicates.push(`DUPLICATE-VERSION: ${seen.get(canonical)} == ${version}`);
    else seen.set(canonical, version);
  }
  return duplicates;
}

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

async function httpGet(url) {
  await acquireSlot();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { error: err.cause?.code || err.cause?.message || err.message };
  } finally {
    releaseSlot();
  }
}

async function withRetries(retries, attempt) {
  let reason;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(Math.min(1000 * 2 ** (i - 1), MAX_BACKOFF_MS));
    const outcome = await attempt();
    if (!outcome.retry) return outcome;
    reason = outcome.retry;
  }
  return { failure: reason };
}

const describeResponse = (res) => `HTTP ${res.status}: ${res.body.trim().replace(/\s+/g, ' ').slice(0, 500)}`;

async function fetchJson(url) {
  const outcome = await withRetries(API_RETRIES, async () => {
    const res = await httpGet(url);
    if (res.error) return { retry: res.error };
    if (res.status !== 200) return { retry: describeResponse(res) };
    return { body: res.body };
  });
  if (outcome.failure) throw new Error(`cannot fetch ${url}: ${outcome.failure}`);
  try {
    return JSON.parse(outcome.body);
  } catch (err) {
    throw new Error(`cannot parse response of ${url}: ${err.message}`);
  }
}

// Only a 404 on the .sha1 means "archive does not exist"; every other failure is transient
async function fetchShasum(url, retries) {
  return withRetries(retries, async () => {
    const res = await httpGet(`${url}.sha1`);
    if (res.error) return { retry: res.error };
    if (res.status === 404) return { missing: true };
    if (res.status !== 200) return { retry: describeResponse(res) };
    const shasum = res.body.trim();
    if (!SHASUM_RE.test(shasum)) return { retry: `HTTP 200 but body is not a SHA-1: ${JSON.stringify(shasum.slice(0, 100))}` };
    return { shasum };
  });
}

function parsePackages(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (!isObject(parsed) || !isObject(parsed.packages)) throw new Error(`${label} has no "packages" object`);
  const known = VARIANTS.map((variant) => variant.name);
  for (const name of Object.keys(parsed.packages)) {
    if (!known.includes(name)) throw new Error(`${label} contains unknown package ${name}`);
    if (!isObject(parsed.packages[name])) throw new Error(`${label}: package ${name} is not an object`);
  }
  return parsed.packages;
}

function readPackages({ required }) {
  if (!fs.existsSync(PACKAGES_FILE)) {
    if (required) throw new Error(`${PACKAGES_FILE} does not exist`);
    return {};
  }
  return parsePackages(fs.readFileSync(PACKAGES_FILE, 'utf8'), PACKAGES_FILE);
}

function readGitBaseline() {
  try {
    const text = execFileSync('git', ['show', `HEAD:./${PACKAGES_FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parsePackages(text, `HEAD:${PACKAGES_FILE}`);
  } catch {
    return null;
  }
}

function validate(packages, previous) {
  const violations = [];
  const expectedNames = VARIANTS.map((variant) => variant.name);
  if (JSON.stringify(Object.keys(packages)) !== JSON.stringify(expectedNames)) {
    violations.push(`PACKAGES: expected exactly [${expectedNames.join(', ')}] in this order, found [${Object.keys(packages).join(', ')}]`);
  }

  for (const variant of VARIANTS) {
    const entries = packages[variant.name];
    if (!isObject(entries)) continue;
    const keys = Object.keys(entries);
    if (keys.length === 0) violations.push(`EMPTY-PACKAGE: ${variant.name} has no versions`);

    const validKeys = keys.filter((key) => VERSION_RE.test(key));
    for (const key of keys) {
      if (!VERSION_RE.test(key)) violations.push(`BAD-VERSION-KEY: ${variant.name} has key ${JSON.stringify(key)}`);
    }
    violations.push(...findDuplicates(validKeys).map((line) => `${line} in ${variant.name}`));
    for (let i = 1; i < validKeys.length; i++) {
      if (compareVersions(validKeys[i - 1], validKeys[i]) < 0) {
        violations.push(`ORDER: ${variant.name} lists ${validKeys[i]} after ${validKeys[i - 1]}, expected strictly descending`);
      }
    }

    for (const key of validKeys) {
      violations.push(...validateEntry(variant, key, entries[key]));
    }

    const before = previous[variant.name] || {};
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(entries, key)) violations.push(`LOST-VERSION: ${variant.name} ${key} was in the previous file`);
    }
    if (keys.length < Object.keys(before).length) {
      violations.push(`SHRUNK: ${variant.name} has ${keys.length} entries, previous file had ${Object.keys(before).length}`);
    }
  }
  return violations;
}

function validateEntry(variant, key, entry) {
  const at = `${variant.name} ${key}`;
  if (!isObject(entry)) return [`MALFORMED: ${at} is not an object`];
  const violations = [];
  if (entry.name !== variant.name) violations.push(`NAME: ${at} has name ${JSON.stringify(entry.name)}`);
  if (entry.version !== key) violations.push(`VERSION: ${at} has version ${JSON.stringify(entry.version)}`);
  if (entry.type !== 'wordpress-core') violations.push(`TYPE: ${at} has type ${JSON.stringify(entry.type)}`);
  if (entry.license !== 'MIT') violations.push(`LICENSE: ${at} has license ${JSON.stringify(entry.license)}`);

  const require = entry.require;
  if (!isObject(require) || Object.keys(require).join() !== 'php' || !PHP_REQUIREMENT_RE.test(require.php)) {
    violations.push(`REQUIRE: ${at} has require ${JSON.stringify(require)}, expected {"php": ">=X.Y"}`);
  }

  const dist = entry.dist;
  if (!isObject(dist)) {
    violations.push(`DIST: ${at} has no dist object`);
  } else {
    if (dist.type !== 'zip') violations.push(`DIST-TYPE: ${at} has dist.type ${JSON.stringify(dist.type)}`);
    const expectedUrl = distUrl(variant, key);
    if (dist.url !== expectedUrl) violations.push(`URL: ${at} has dist.url ${JSON.stringify(dist.url)}, expected ${expectedUrl}`);
    if (typeof dist.shasum !== 'string' || !SHASUM_RE.test(dist.shasum)) {
      violations.push(`SHASUM: ${at} has dist.shasum ${JSON.stringify(dist.shasum)}, expected 40 lowercase hex characters`);
    }
  }

  const extra = entry.extra;
  if (extra !== undefined && (!isObject(extra) || Object.keys(extra).join() !== 'mysql_version' || typeof extra.mysql_version !== 'string')) {
    violations.push(`EXTRA: ${at} has extra ${JSON.stringify(extra)}, expected only {"mysql_version": "<string>"}`);
  }
  return violations;
}

function asymmetricLines(packages) {
  const lines = [];
  for (const variant of VARIANTS) {
    const other = VARIANTS.find((candidate) => candidate !== variant);
    for (const key of Object.keys(packages[variant.name] || {})) {
      if (!Object.hasOwn(packages[other.name] || {}, key)) lines.push(`ASYMMETRIC: ${key} exists only in ${variant.name}`);
    }
  }
  return lines;
}

function normalizeHost(url) {
  try {
    const parsed = new URL(url);
    parsed.protocol = 'https:';
    parsed.hostname = DOWNLOAD_HOST;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function buildEntry(fields, url, shasum) {
  const entry = {
    name: fields.name,
    version: fields.version,
    type: fields.type,
    license: fields.license,
    require: fields.require,
    dist: { type: fields.distType, url, shasum }
  };
  if (fields.extra !== undefined) entry.extra = fields.extra;
  return entry;
}

const storedFields = (stored) => ({
  name: stored?.name,
  version: stored?.version,
  type: stored?.type,
  license: stored?.license,
  require: stored?.require,
  distType: stored?.dist?.type,
  extra: stored?.extra
});

function newFields(variant, version, metadata) {
  return {
    name: variant.name,
    version,
    type: 'wordpress-core',
    license: 'MIT',
    require: { php: metadata.php },
    distType: 'zip',
    extra: metadata.extra
  };
}

function metadataFromSibling(sibling) {
  return { php: sibling.require?.php, extra: sibling.extra };
}

function metadataFromOffer(offer) {
  if (!offer || typeof offer.php_version !== 'string') return null;
  const php = `>=${offer.php_version.split('.').slice(0, 2).join('.')}`;
  if (!PHP_REQUIREMENT_RE.test(php)) return null;
  const mysql = typeof offer.mysql_version === 'string' && offer.mysql_version !== '' ? offer.mysql_version : undefined;
  return { php, extra: mysql === undefined ? undefined : { mysql_version: mysql } };
}

async function resolveExisting(variant, version, stored) {
  const url = normalizeHost(stored?.dist?.url);
  if (url === undefined) return { status: 'failed', reason: `${variant.name} ${version}: stored entry has no usable dist.url` };
  const fields = storedFields(stored);
  const storedShasum = stored?.dist?.shasum;
  if (typeof storedShasum === 'string' && SHASUM_RE.test(storedShasum)) {
    return { status: 'kept', entry: buildEntry(fields, url, storedShasum) };
  }
  const result = await fetchShasum(url, EXISTING_ENTRY_RETRIES);
  if (result.shasum) return { status: 'kept', entry: buildEntry(fields, url, result.shasum) };
  const cause = result.missing
    ? 'HTTP 404, the archive does not exist (withdrawn upstream, or the stored URL is wrong)'
    : `${result.failure} (after ${EXISTING_ENTRY_RETRIES} retries)`;
  return { status: 'failed', reason: `${variant.name} ${version}: existing entry has no obtainable shasum from ${url}.sha1: ${cause}` };
}

function readVersionPhpAssignment(text, name) {
  const matches = [...text.matchAll(new RegExp(`^[ \\t]*\\$${name}[ \\t]*=[ \\t]*(['"])(\\d+(?:\\.\\d+){1,2})\\1[ \\t]*;`, 'gm'))];
  return matches.length === 1 ? matches[0][2] : null;
}

function parseVersionPhp(text) {
  const phpVersion = readVersionPhpAssignment(text, 'required_php_version');
  const mysqlVersion = readVersionPhpAssignment(text, 'required_mysql_version');
  if (phpVersion === null || mysqlVersion === null) return null;
  const php = `>=${phpVersion.split('.').slice(0, 2).join('.')}`;
  if (!PHP_REQUIREMENT_RE.test(php)) return null;
  return { php, extra: { mysql_version: mysqlVersion } };
}

// The last metadata source: only asked for a new version that has no sibling and no usable offer
async function fetchVersionPhpMetadata(version) {
  const outcomes = [];
  for (const buildUrl of VERSION_PHP_URLS) {
    const url = buildUrl(version);
    const outcome = await withRetries(NEW_ENTRY_RETRIES, async () => {
      const res = await httpGet(url);
      if (res.error) return { retry: res.error };
      if (res.status === 404) return { missing: true };
      if (res.status !== 200) return { retry: describeResponse(res) };
      const metadata = parseVersionPhp(res.body);
      if (!metadata) return { retry: 'HTTP 200 but the body has no single $required_php_version and $required_mysql_version assignment' };
      return { metadata };
    });
    if (outcome.metadata) return { metadata: outcome.metadata };
    outcomes.push({ url, outcome });
  }
  if (outcomes.every(({ outcome }) => outcome.missing)) {
    return { failure: `EXCEPTION: no metadata source, version.php returned 404 from ${outcomes.map(({ url }) => url).join(' and ')} although the archive exists` };
  }
  const causes = outcomes.map(({ url, outcome }) => `${url}: ${outcome.missing ? 'HTTP 404' : `${outcome.failure} (after ${NEW_ENTRY_RETRIES} retries)`}`);
  return { failure: `no metadata source, ${causes.join('; ')}` };
}

async function resolveNew(variant, version, sibling, offer, getVersionPhpMetadata) {
  const url = distUrl(variant, version);
  const result = await fetchShasum(url, NEW_ENTRY_RETRIES);
  if (result.missing) return { status: 'skipped', reason: `${variant.name} ${version}: ${url}.sha1 returned 404` };
  if (result.failure) return { status: 'deferred', reason: `${variant.name} ${version}: ${result.failure}` };
  let metadata = sibling ? metadataFromSibling(sibling) : metadataFromOffer(offer);
  if (!metadata) {
    const fetched = await getVersionPhpMetadata();
    if (fetched.failure) return { status: 'deferred', reason: `${variant.name} ${version}: ${fetched.failure}` };
    metadata = fetched.metadata;
  }
  return { status: 'added', entry: buildEntry(newFields(variant, version, metadata), url, result.shasum) };
}

async function resolveVersion(version, previous, offer) {
  let versionPhpMetadata;
  const getVersionPhpMetadata = () => (versionPhpMetadata ??= fetchVersionPhpMetadata(version));
  const results = await Promise.all(VARIANTS.map((variant) => {
    const stored = previous[variant.name]?.[version];
    if (stored !== undefined) return resolveExisting(variant, version, stored);
    const other = VARIANTS.find((candidate) => candidate !== variant);
    return resolveNew(variant, version, previous[other.name]?.[version], offer, getVersionPhpMetadata);
  }));
  // A transient failure on one new variant defers the whole version so it is never half published
  if (results.some((result) => result.status === 'deferred')) {
    return results.map((result) => (result.status === 'added' ? { status: 'deferred', reason: `${result.entry.name} ${version}: paired with a deferred variant` } : result));
  }
  return results;
}

async function fetchOffers() {
  const offers = (await fetchJson(API_URL)).offers;
  if (!Array.isArray(offers)) throw new Error(`${API_URL} returned no "offers" array`);
  const byVersion = new Map();
  const ignored = [];
  for (const offer of offers) {
    const version = offer?.version;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      ignored.push(`IGNORED-VERSION: ${JSON.stringify(version)} (from offers)`);
    } else if (!byVersion.has(version)) {
      byVersion.set(version, offer);
    }
  }
  return { byVersion, ignored };
}

async function fetchStableVersions() {
  const statuses = await fetchJson(STABLE_CHECK_URL);
  if (!isObject(statuses) || Object.keys(statuses).length === 0) throw new Error(`${STABLE_CHECK_URL} returned no version object`);
  const versions = [];
  const ignored = [];
  for (const key of Object.keys(statuses)) {
    if (!VERSION_RE.test(key)) ignored.push(`IGNORED-VERSION: ${JSON.stringify(key)} (from stable-check)`);
    else if (compareVersions(key, MIN_VERSION) >= 0) versions.push(key);
  }
  if (versions.length === 0) throw new Error(`${STABLE_CHECK_URL} lists no stable version >= ${MIN_VERSION}, refusing to run without enumeration`);
  return { versions, ignored };
}

function printReport(packages, added, lists) {
  for (const variant of VARIANTS) console.log(`${variant.name}: ${Object.keys(packages[variant.name]).length} versions`);
  console.log(`Added versions: ${added.length ? added.join(', ') : 'none'}`);
  for (const line of [...lists.skipped, ...lists.asymmetric, ...lists.deferred, ...lists.ignored]) console.log(line);
}

async function generate() {
  const previous = readPackages({ required: false });
  const existingVersions = new Set();
  for (const entries of Object.values(previous)) {
    for (const key of Object.keys(entries)) {
      if (!VERSION_RE.test(key)) throw new Error(`existing key ${JSON.stringify(key)} does not match the stable version pattern; decide by hand`);
      existingVersions.add(key);
    }
  }

  const { byVersion: offerByVersion, ignored: ignoredOffers } = await fetchOffers();
  const { versions: stableVersions, ignored: ignoredStable } = await fetchStableVersions();
  const ignored = [...ignoredOffers, ...ignoredStable];
  const versions = new Set([...existingVersions, ...offerByVersion.keys(), ...stableVersions]);
  const duplicates = findDuplicates(versions);
  if (duplicates.length) throw new Error(duplicates.join('\n'));
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));

  const resolved = await Promise.all(sorted.map((version) => resolveVersion(version, previous, offerByVersion.get(version))));

  const failures = resolved.flat().filter((result) => result.status === 'failed').map((result) => result.reason);
  if (failures.length) throw new Error(`${failures.length} existing entr${failures.length === 1 ? 'y' : 'ies'} failed, nothing written:\n${failures.join('\n')}`);

  const packages = {};
  const added = [];
  const lists = { skipped: [], deferred: [], ignored, asymmetric: [] };
  const deferredVersions = new Set();
  for (const variant of VARIANTS) packages[variant.name] = {};
  sorted.forEach((version, index) => {
    VARIANTS.forEach((variant, variantIndex) => {
      const result = resolved[index][variantIndex];
      if (result.entry) packages[variant.name][version] = result.entry;
      if (result.status === 'added' && !added.includes(version)) added.push(version);
      if (result.status === 'skipped') lists.skipped.push(`SKIPPED-NO-ARCHIVE: ${result.reason}`);
      if (result.status === 'deferred') {
        lists.deferred.push(`DEFERRED: ${result.reason}`);
        deferredVersions.add(version);
      }
    });
  });
  lists.asymmetric = asymmetricLines(packages);

  const violations = validate(packages, previous);
  if (violations.length) throw new Error(`${violations.length} invariant violation(s), nothing written:\n${violations.join('\n')}`);

  fs.writeFileSync(PACKAGES_FILE, `${JSON.stringify({ packages }, null, 2)}\n`);

  printReport(packages, added, lists);
  if (deferredVersions.size) console.log(`INCOMPLETE: ${deferredVersions.size} version(s) deferred`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit_version=${added[0] || ''}\nincomplete=${deferredVersions.size}\n`);
  }
}

async function check() {
  const packages = readPackages({ required: true });
  const baseline = readGitBaseline();
  const violations = validate(packages, baseline || {});
  console.log(baseline ? `Compared against HEAD:${PACKAGES_FILE} for lost or dropped versions` : 'No git baseline available; lost or dropped versions were not checked');
  for (const line of asymmetricLines(packages)) console.log(line);
  if (violations.length) {
    for (const violation of violations) console.error(`VIOLATION ${violation}`);
    throw new Error(`${violations.length} invariant violation(s) in ${PACKAGES_FILE}`);
  }
  console.log(`${PACKAGES_FILE} passes all invariants`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('usage: node generate-packages-json.js [--check]');
  await (args.length ? check() : generate());
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exitCode = 1;
});
