'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const {
  API_URL: DEFAULT_API_URL,
  STABLE_CHECK_URL: DEFAULT_STABLE_CHECK_URL,
  VERSION_PHP_URLS,
  LICENSE,
  MIN_VERSION,
  VERSION_RE,
  ANY_VERSION_RE,
  SHASUM_RE,
  PHP_REQUIREMENT_RE,
  VARIANTS,
  HOMEPAGE,
  SUPPORT,
  CORE_IMPLEMENTATION,
  SOURCE_URL,
  betaChannelUrl
} = require('./lib/constants');
const { isObject, distUrl, normalizeHost } = require('./lib/util');
const { compareVersions, findDuplicates } = require('./lib/versions');
const { httpGet, httpGetBuffer, describeResponse, withRetries } = require('./lib/http');
const { sha1, md5, MD5_RE } = require('./lib/checksums');
const { parsePackages, readPackagesFile } = require('./lib/packages-file');

const PACKAGES_FILE = 'packages.json';

// API_URL_OVERRIDE is a test seam; the workflow never sets it. A function (not a snapshot taken at
// require time) so tests can point it at a fresh local server per test within the same process,
// the same reason DOWNLOAD_BASE_OVERRIDE/probeBase() in lib/constants.js is a function too.
const apiUrl = () => process.env.API_URL_OVERRIDE || DEFAULT_API_URL;
// STABLE_CHECK_URL_OVERRIDE is a test seam; the workflow never sets it. Same rationale as apiUrl().
const stableCheckUrl = () => process.env.STABLE_CHECK_URL_OVERRIDE || DEFAULT_STABLE_CHECK_URL;

const API_RETRIES = 2;
const NEW_ENTRY_RETRIES = 2;
const EXISTING_ENTRY_RETRIES = 5;

const ALLOWED_ENTRY_FIELDS = ['name', 'version', 'type', 'description', 'keywords', 'homepage', 'license', 'support', 'require', 'provide', 'source', 'dist', 'extra'];

async function fetchJson(url) {
  const outcome = await withRetries(async () => {
    const res = await httpGet(url);
    if (res.error) return { retry: res.error };
    if (res.status !== 200) return { retry: describeResponse(res) };
    return { body: res.body };
  }, { retries: API_RETRIES });
  if (outcome.failure) throw new Error(`cannot fetch ${url}: ${outcome.failure}`);
  try {
    return JSON.parse(outcome.body);
  } catch (err) {
    throw new Error(`cannot parse response of ${url}: ${err.message}`);
  }
}

// Only a 404 on the .sha1 means "archive does not exist"; every other failure is transient.
// lastModified (raw header value, or undefined) is the .sha1 response's Last-Modified header; it is
// only a fallback for the job summary (T5.1) - verifyArchive's archive response is preferred there.
async function fetchShasum(url, retries) {
  return withRetries(async () => {
    const res = await httpGet(`${url}.sha1`);
    if (res.error) return { retry: res.error };
    if (res.status === 404) return { missing: true };
    if (res.status !== 200) return { retry: describeResponse(res) };
    const shasum = res.body.trim();
    if (!SHASUM_RE.test(shasum)) return { retry: `HTTP 200 but body is not a SHA-1: ${JSON.stringify(shasum.slice(0, 100))}` };
    const result = { shasum };
    if (res.headers?.['last-modified'] != null) result.lastModified = res.headers['last-modified'];
    return result;
  }, { retries });
}

// Downloads the archive, hashes it locally and compares against the already-fetched published SHA-1;
// then does the same for the (optional) published MD5. Never trusts the upstream shasum alone.
// Returns { ok: true, bytes, noMd5? }, { ok: false, mismatch: 'sha1'|'md5', expected, actual } or
// { failure: <reason> } for exhausted transient failures (see contract C3 in the plan).
async function verifyArchive(url, expectedSha1, retries) {
  const archiveOutcome = await withRetries(async () => {
    const res = await httpGetBuffer(url);
    if (res.error) return { retry: res.error };
    if (res.status !== 200) {
      return { retry: `HTTP ${res.status}: ${res.buffer.toString('utf8').trim().replace(/\s+/g, ' ').slice(0, 500)}` };
    }
    return { buffer: res.buffer, headers: res.headers };
  }, { retries });
  if (archiveOutcome.failure) return { failure: archiveOutcome.failure };

  const actualSha1 = sha1(archiveOutcome.buffer);
  if (actualSha1 !== expectedSha1) return { ok: false, mismatch: 'sha1', expected: expectedSha1, actual: actualSha1 };

  // A 404 on .md5 is normal (not every archive has one) and never fails the run.
  const md5Outcome = await withRetries(async () => {
    const res = await httpGet(`${url}.md5`);
    if (res.error) return { retry: res.error };
    if (res.status === 404) return { noMd5: true };
    if (res.status !== 200) return { retry: describeResponse(res) };
    const published = res.body.trim();
    if (!MD5_RE.test(published)) return { retry: `HTTP 200 but body is not an MD5: ${JSON.stringify(published.slice(0, 100))}` };
    return { published };
  }, { retries });
  if (md5Outcome.failure) return { failure: md5Outcome.failure };

  // Preferred source for the job summary (T5.1): this is the archive's own Last-Modified header,
  // already downloaded above - not the (weaker) .sha1 response header fetchShasum also carries.
  const okResult = { ok: true, bytes: archiveOutcome.buffer.length };
  if (archiveOutcome.headers?.['last-modified'] != null) okResult.lastModified = archiveOutcome.headers['last-modified'];

  if (md5Outcome.noMd5) return { ...okResult, noMd5: true };

  const actualMd5 = md5(archiveOutcome.buffer);
  if (actualMd5 !== md5Outcome.published) return { ok: false, mismatch: 'md5', expected: md5Outcome.published, actual: actualMd5 };

  return okResult;
}

function readPackages({ required }) {
  return readPackagesFile(PACKAGES_FILE, { required });
}

// packages.json only grows over time (adding Composer metadata to every entry took it from ~672 KB
// to ~1.46 MB), so give `git show` a generous maxBuffer well above Node's 1 MiB default. Without this,
// execFileSync throws ENOBUFS once the file crosses 1 MiB and the baseline was silently treated as
// absent, disabling the LOST-VERSION/SHRUNK checks below.
const GIT_SHOW_MAX_BUFFER = 256 * 1024 * 1024; // 256 MiB

function readGitBaseline() {
  let text;
  try {
    text = execFileSync('git', ['show', `HEAD:./${PACKAGES_FILE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_SHOW_MAX_BUFFER
    });
  } catch (err) {
    // Legitimate "no baseline" cases, where git ran and reported it has nothing to show: git is not
    // installed (ENOENT), or git exited with a non-zero status because there is no repository, no
    // HEAD, or PACKAGES_FILE did not exist at HEAD yet (all reported as a non-zero exit, typically
    // 128). Anything else - most notably ENOBUFS from a too-small maxBuffer, or any other unexpected
    // failure - means a baseline exists but could not be read, and must not be conflated with "no
    // baseline": doing so would silently disable the LOST-VERSION/SHRUNK invariant checks.
    // Residual trade-off: git's stderr is discarded (redirected to 'ignore' above), so any non-zero
    // git exit - including rare causes such as a corrupted object store - is indistinguishable from
    // the legitimate "no repository/HEAD/file" cases and is treated as "no baseline".
    if (err.code === 'ENOENT' || typeof err.status === 'number') return null;
    throw new Error(`could not read git baseline HEAD:${PACKAGES_FILE}: ${err.message}`);
  }
  // The baseline exists and was read; parsePackages already includes the "HEAD:packages.json" label
  // in its error message, so let that error propagate as-is rather than wrapping it again. It must
  // fail loudly rather than being treated as "no baseline".
  return parsePackages(text, `HEAD:${PACKAGES_FILE}`);
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

    const validKeys = keys.filter((key) => ANY_VERSION_RE.test(key));
    for (const key of keys) {
      if (!ANY_VERSION_RE.test(key)) violations.push(`BAD-VERSION-KEY: ${variant.name} has key ${JSON.stringify(key)}`);
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
  if (entry.license !== LICENSE) violations.push(`LICENSE: ${at} has license ${JSON.stringify(entry.license)}`);

  if (entry.description !== variant.description) {
    violations.push(`DESCRIPTION: ${at} has description ${JSON.stringify(entry.description)}, expected ${JSON.stringify(variant.description)}`);
  }
  if (JSON.stringify(entry.keywords) !== JSON.stringify(variant.keywords)) {
    violations.push(`KEYWORDS: ${at} has keywords ${JSON.stringify(entry.keywords)}, expected ${JSON.stringify(variant.keywords)}`);
  }
  if (entry.homepage !== HOMEPAGE) {
    violations.push(`HOMEPAGE: ${at} has homepage ${JSON.stringify(entry.homepage)}, expected ${JSON.stringify(HOMEPAGE)}`);
  }
  if (JSON.stringify(entry.support) !== JSON.stringify(SUPPORT)) {
    violations.push(`SUPPORT: ${at} has support ${JSON.stringify(entry.support)}, expected ${JSON.stringify(SUPPORT)}`);
  }
  const expectedProvide = { [CORE_IMPLEMENTATION]: key };
  if (JSON.stringify(entry.provide) !== JSON.stringify(expectedProvide)) {
    violations.push(`PROVIDE: ${at} has provide ${JSON.stringify(entry.provide)}, expected ${JSON.stringify(expectedProvide)}`);
  }
  if (variant.hasSource) {
    const expectedSource = { type: 'git', url: SOURCE_URL, reference: key };
    if (JSON.stringify(entry.source) !== JSON.stringify(expectedSource)) {
      violations.push(`SOURCE: ${at} has source ${JSON.stringify(entry.source)}, expected ${JSON.stringify(expectedSource)}`);
    }
  } else if (entry.source !== undefined) {
    violations.push(`SOURCE: ${at} must not declare a source`);
  }

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

  const unknown = Object.keys(entry).filter((field) => !ALLOWED_ENTRY_FIELDS.includes(field));
  if (unknown.length) violations.push(`UNKNOWN-FIELD: ${at} has unexpected field(s) ${JSON.stringify(unknown)}`);

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

function buildEntry(variant, fields, url, shasum) {
  const entry = {
    name: fields.name,
    version: fields.version,
    type: fields.type,
    description: variant.description,
    keywords: [...variant.keywords],
    homepage: HOMEPAGE,
    license: LICENSE,
    support: { ...SUPPORT },
    require: fields.require,
    provide: { [CORE_IMPLEMENTATION]: fields.version }
  };
  if (variant.hasSource) entry.source = { type: 'git', url: SOURCE_URL, reference: fields.version };
  entry.dist = { type: fields.distType, url, shasum };
  if (fields.extra !== undefined) entry.extra = fields.extra;
  return entry;
}

const storedFields = (stored) => ({
  name: stored?.name,
  version: stored?.version,
  type: stored?.type,
  require: stored?.require,
  distType: stored?.dist?.type,
  extra: stored?.extra
});

function newFields(variant, version, metadata) {
  return {
    name: variant.name,
    version,
    type: 'wordpress-core',
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
    return { status: 'kept', entry: buildEntry(variant, fields, url, storedShasum) };
  }
  const result = await fetchShasum(url, EXISTING_ENTRY_RETRIES);
  if (result.shasum) return { status: 'kept', entry: buildEntry(variant, fields, url, result.shasum) };
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
    const outcome = await withRetries(async () => {
      const res = await httpGet(url);
      if (res.error) return { retry: res.error };
      if (res.status === 404) return { missing: true };
      if (res.status !== 200) return { retry: describeResponse(res) };
      const metadata = parseVersionPhp(res.body);
      if (!metadata) return { retry: 'HTTP 200 but the body has no single $required_php_version and $required_mysql_version assignment' };
      return { metadata };
    }, { retries: NEW_ENTRY_RETRIES });
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

  const verification = await verifyArchive(url, result.shasum, NEW_ENTRY_RETRIES);
  if (verification.failure) return { status: 'deferred', reason: `${variant.name} ${version}: ${verification.failure}` };
  if (!verification.ok) {
    return {
      status: 'deferred',
      reason: `${variant.name} ${version}: CHECKSUM-MISMATCH ${verification.mismatch} of ${url}: published ${verification.expected}, computed ${verification.actual}`
    };
  }

  let metadata = sibling ? metadataFromSibling(sibling) : metadataFromOffer(offer);
  if (!metadata) {
    const fetched = await getVersionPhpMetadata();
    if (fetched.failure) return { status: 'deferred', reason: `${variant.name} ${version}: ${fetched.failure}` };
    metadata = fetched.metadata;
  }
  const added = { status: 'added', entry: buildEntry(variant, newFields(variant, version, metadata), url, result.shasum) };
  if (verification.noMd5) added.noMd5 = `NO-MD5: ${variant.name} ${version}: ${url}.md5 returned 404`;
  // Job summary (T5.1): prefer the archive's own Last-Modified, fall back to the .sha1 response's.
  const lastModified = verification.lastModified ?? result.lastModified;
  if (lastModified !== undefined) added.lastModified = lastModified;
  return added;
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

// Never throws: the beta channel is advisory only (plan Design decision 7). Any failure - network,
// non-200, unparseable body, missing "offers" array - logs BETA-CHANNEL-UNAVAILABLE and yields no offers.
async function fetchBetaOffers() {
  const url = betaChannelUrl(apiUrl());
  try {
    const outcome = await withRetries(async () => {
      const res = await httpGet(url);
      if (res.error) return { retry: res.error };
      if (res.status !== 200) return { retry: describeResponse(res) };
      return { body: res.body };
    }, { retries: API_RETRIES });
    if (outcome.failure) {
      console.log(`BETA-CHANNEL-UNAVAILABLE: cannot fetch ${url}: ${outcome.failure}`);
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(outcome.body);
    } catch (err) {
      console.log(`BETA-CHANNEL-UNAVAILABLE: cannot parse response of ${url}: ${err.message}`);
      return [];
    }
    if (!Array.isArray(parsed.offers)) {
      console.log(`BETA-CHANNEL-UNAVAILABLE: ${url} returned no "offers" array`);
      return [];
    }
    return parsed.offers;
  } catch (err) {
    console.log(`BETA-CHANNEL-UNAVAILABLE: ${err.message}`);
    return [];
  }
}

// Merges the stable and beta channels by version; on a key collision the stable channel's offer
// wins (it is authoritative for a stable version). Prereleases therefore only ever enter through
// offers, never through fetchStableVersions' enumeration (see plan backlog 3.4).
async function fetchOffers() {
  const url = apiUrl();
  const stableOffers = (await fetchJson(url)).offers;
  if (!Array.isArray(stableOffers)) throw new Error(`${url} returned no "offers" array`);
  const betaOffers = await fetchBetaOffers();
  const byVersion = new Map();
  const ignored = [];
  for (const offer of [...stableOffers, ...betaOffers]) {
    const version = offer?.version;
    if (typeof version !== 'string' || !ANY_VERSION_RE.test(version)) {
      ignored.push(`IGNORED-VERSION: ${JSON.stringify(version)} (from offers)`);
    } else if (!byVersion.has(version)) {
      byVersion.set(version, offer);
    }
  }
  return { byVersion, ignored };
}

async function fetchStableVersions() {
  const url = stableCheckUrl();
  const statuses = await fetchJson(url);
  if (!isObject(statuses) || Object.keys(statuses).length === 0) throw new Error(`${url} returned no version object`);
  const versions = [];
  const ignored = [];
  for (const key of Object.keys(statuses)) {
    if (!VERSION_RE.test(key)) ignored.push(`IGNORED-VERSION: ${JSON.stringify(key)} (from stable-check)`);
    else if (compareVersions(key, MIN_VERSION) >= 0) versions.push(key);
  }
  if (versions.length === 0) throw new Error(`${url} lists no stable version >= ${MIN_VERSION}, refusing to run without enumeration`);
  return { versions, ignored };
}

function printReport(packages, added, lists) {
  for (const variant of VARIANTS) console.log(`${variant.name}: ${Object.keys(packages[variant.name]).length} versions`);
  console.log(`Added versions: ${added.length ? added.join(', ') : 'none'}`);
  for (const line of [...lists.skipped, ...lists.noMd5, ...lists.asymmetric, ...lists.deferred, ...lists.ignored]) console.log(line);
}

// Any text taken from an HTTP header is untrusted: only a parsed Date (rendered as ISO 8601 UTC) or
// the literal "unknown" ever reaches the summary - never the raw header string.
function parseHeaderDate(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

const toIso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Largest-two-unit rendering, e.g. "9m 33s", "2h 15m", "3d 4h". Clamped to zero so clock skew never
// renders a negative lag.
function formatLag(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Table cells are our own version/package strings plus derived values, but escape defensively
// anyway: a literal "|" in a cell would corrupt the Markdown table.
const escapeCell = (value) => String(value).replace(/\|/g, '\\|');

// Pure Markdown formatter for the "Added versions" job summary (T5.1). rows: [{version, package,
// lastModified}], lastModified being the raw Last-Modified header value (or undefined) captured by
// resolveNew - the archive response's header is preferred there, falling back to the .sha1
// response's. now: a single Date shared by every row in the run. Returns '' for an empty row list.
function formatSummary(rows, now) {
  if (!rows.length) return '';
  const lines = [
    '## Added versions',
    '',
    '| Version | Package | Archive published (Last-Modified) | Observed by the generator | Lag |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const row of rows) {
    const published = parseHeaderDate(row.lastModified);
    const publishedCell = published ? toIso(published) : 'unknown';
    const observedCell = published ? toIso(now) : 'unknown';
    const lagCell = published ? formatLag(now.getTime() - published.getTime()) : '—';
    lines.push(`| ${escapeCell(row.version)} | ${escapeCell(row.package)} | ${publishedCell} | ${observedCell} | ${lagCell} |`);
  }
  return `${lines.join('\n')}\n`;
}

// Never allowed to fail the run: writing the job summary is best-effort. Skipped entirely (no I/O
// attempted at all) when GITHUB_STEP_SUMMARY is unset, so tests never need a writable path for that case.
function writeJobSummary(rows) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    const markdown = formatSummary(rows, new Date());
    if (markdown) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  } catch (err) {
    console.warn(`SUMMARY-FAILED: ${err.message}`);
  }
}

async function generate() {
  const previous = readPackages({ required: false });
  const existingVersions = new Set();
  for (const entries of Object.values(previous)) {
    for (const key of Object.keys(entries)) {
      if (!ANY_VERSION_RE.test(key)) throw new Error(`existing key ${JSON.stringify(key)} does not match the stable version pattern; decide by hand`);
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
  const lists = { skipped: [], deferred: [], ignored, asymmetric: [], noMd5: [] };
  const deferredVersions = new Set();
  const summaryRows = [];
  for (const variant of VARIANTS) packages[variant.name] = {};
  sorted.forEach((version, index) => {
    VARIANTS.forEach((variant, variantIndex) => {
      const result = resolved[index][variantIndex];
      if (result.entry) packages[variant.name][version] = result.entry;
      if (result.status === 'added') {
        if (!added.includes(version)) added.push(version);
        summaryRows.push({ version, package: variant.name, lastModified: result.lastModified });
      }
      if (result.status === 'skipped') lists.skipped.push(`SKIPPED-NO-ARCHIVE: ${result.reason}`);
      if (result.noMd5) lists.noMd5.push(result.noMd5);
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
  writeJobSummary(summaryRows);
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

// Rebuilds every entry through buildEntry from data already in the file. Performs zero network
// requests; never adds or removes a version. Reusable whenever buildEntry's computed fields change.
async function backfill() {
  const stored = readPackages({ required: true });
  const packages = {};
  const badEntries = [];
  for (const variant of VARIANTS) {
    const entries = stored[variant.name] || {};
    packages[variant.name] = {};
    for (const key of Object.keys(entries)) {
      const entry = entries[key];
      const url = normalizeHost(entry?.dist?.url);
      const shasum = entry?.dist?.shasum;
      if (url === undefined || typeof shasum !== 'string' || !SHASUM_RE.test(shasum)) {
        badEntries.push(`${variant.name} ${key}: dist.url=${JSON.stringify(entry?.dist?.url)}, dist.shasum=${JSON.stringify(shasum)}`);
        continue;
      }
      packages[variant.name][key] = buildEntry(variant, storedFields(entry), url, shasum);
    }
  }
  if (badEntries.length) {
    throw new Error(`${badEntries.length} entr${badEntries.length === 1 ? 'y has' : 'ies have'} no usable dist.url/dist.shasum, nothing written:\n${badEntries.join('\n')}`);
  }

  const violations = validate(packages, stored);
  if (violations.length) throw new Error(`${violations.length} invariant violation(s), nothing written:\n${violations.join('\n')}`);

  for (const variant of VARIANTS) {
    const beforeKeys = Object.keys(stored[variant.name] || {});
    const afterKeys = Object.keys(packages[variant.name]);
    if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
      throw new Error(`${variant.name}: backfill changed the key count or order, nothing written`);
    }
  }

  fs.writeFileSync(PACKAGES_FILE, `${JSON.stringify({ packages }, null, 2)}\n`);

  for (const variant of VARIANTS) console.log(`${variant.name}: ${Object.keys(packages[variant.name]).length} versions rebuilt`);
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'usage: node generate-packages-json.js [--check|--backfill]';
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check' && args[0] !== '--backfill')) throw new Error(usage);
  if (args[0] === '--check') return check();
  if (args[0] === '--backfill') return backfill();
  return generate();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  validate,
  validateEntry,
  buildEntry,
  storedFields,
  newFields,
  metadataFromSibling,
  metadataFromOffer,
  parseVersionPhp,
  readVersionPhpAssignment,
  asymmetricLines,
  verifyArchive,
  resolveExisting,
  resolveNew,
  resolveVersion,
  fetchOffers,
  fetchBetaOffers,
  fetchStableVersions,
  formatSummary,
  writeJobSummary,
  check,
  generate,
  backfill
};
