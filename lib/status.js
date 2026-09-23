'use strict';

const fs = require('fs');
const path = require('path');

const { VARIANTS } = require('./constants');
const { compareVersions, isPrerelease } = require('./versions');
const { formatLag } = require('./time');

const STATUS_FILE = 'status.json';
const BADGES_DIR = 'badges';

// Highest key under compareVersions among the given keys, restricted to those passing `filter` (if
// given); null if none qualify. Prereleases are included unless the caller's filter excludes them.
function highestVersion(keys, filter) {
  let best = null;
  for (const key of keys) {
    if (filter && !filter(key)) continue;
    if (best === null || compareVersions(key, best) > 0) best = key;
  }
  return best;
}

// buildStatus(packages, pickup) -> the Data contract A object. Pure: no I/O, no clock read.
// `packages` is the same shape generate() builds: { [packageName]: { [version]: entry } }.
function buildStatus(packages, pickup) {
  const statusPackages = {};
  const allKeys = [];

  for (const variant of VARIANTS) {
    const entries = (packages && packages[variant.name]) || {};
    const keys = Object.keys(entries);
    allKeys.push(...keys);
    statusPackages[variant.name] = {
      latest: highestVersion(keys),
      latestStable: highestVersion(keys, (key) => !isPrerelease(key)),
      count: keys.length
    };
  }

  const latestStable = highestVersion(allKeys, (key) => !isPrerelease(key));
  const latestPrereleaseCandidate = highestVersion(allKeys, (key) => isPrerelease(key));
  const latestPrerelease =
    latestPrereleaseCandidate !== null &&
    (latestStable === null || compareVersions(latestPrereleaseCandidate, latestStable) > 0)
      ? latestPrereleaseCandidate
      : null;

  return {
    schemaVersion: 1,
    packages: statusPackages,
    wordpress: { latestStable, latestPrerelease },
    pickup: pickup || null
  };
}

// Derives the badges/<name>.json filename from a package name's segment after '/'.
function variantBadgeFile(packageName) {
  return `${packageName.split('/')[1]}.json`;
}

// The label/message/color for a single variant's `latest` entry, per Data contract B.
function variantBadge(label, latest) {
  if (latest === null) return { schemaVersion: 1, label, message: 'none', color: 'lightgrey' };
  if (isPrerelease(latest)) {
    return { schemaVersion: 1, label, message: `${latest} (pre-release)`, color: 'orange' };
  }
  return { schemaVersion: 1, label, message: latest, color: 'blue' };
}

// Splits one pickup's delay into the part that happened before this repository could see the
// release and the part that happened after. The two are bounded from opposite sides and add up to
// lagSeconds exactly, which is the entire reason they are shown as two badges instead of one total
// that reads as though all of it were ours.
//
// `theirs` is a lower bound - the archive existed from publishedAt and was still not announced at
// previousCheckAt, so at least that much of the wait was wordpress.org's - and it is rendered as a
// plain figure, which makes the badge understate that share rather than overstate it. `ours` is an upper bound,
// and the tighter of two: we cannot have been slower than the interval since that check, nor slower
// than the archive has existed at all. The second one wins when the archive was built after the
// check - the fast path, where a release appears mid-interval and is taken on the very next cycle,
// and where the split is genuinely unknowable.
//
// Returns null for a record written before the reaction was measured; the caller then shows the
// undivided total rather than guessing at a division.
function splitLag(pickup) {
  if (typeof pickup.reactionSeconds !== 'number' || typeof pickup.lagSeconds !== 'number') return null;
  return {
    theirs: Math.max(0, pickup.lagSeconds - pickup.reactionSeconds),
    ours: Math.min(pickup.lagSeconds, pickup.reactionSeconds)
  };
}

// wordpress.org's share of the delay. The batch size belongs in the message because a mass backport
// wave and a single release read very differently at the same number of minutes: 19 versions at once
// is wordpress.org's build queue, not a stall here. A pickup carried forward from before batchSize
// existed reads as a single release - the same as any ordinary run.
function pickupBadge(pickup) {
  const label = 'wordpress.org \u2192 package';
  if (pickup === null) return { schemaVersion: 1, label, message: 'not measured yet', color: 'lightgrey' };
  const subject = pickup.batchSize > 1 ? `${pickup.version}, newest of ${pickup.batchSize}` : pickup.version;
  const split = splitLag(pickup);
  const seconds = split ? split.theirs : pickup.lagSeconds;
  const message = `${formatLag(seconds * 1000)} (${subject})`;
  return { schemaVersion: 1, label, message, color: 'informational' };
}

// This repository's own share. The figure is an upper bound: the release was invisible at the
// previous check and present at this one, so the exact moment it appeared is not recoverable and
// the true reaction can only be shorter than what the badge shows, never longer.
function reactionBadge(pickup) {
  const label = 'pickup reaction';
  const split = pickup === null ? null : splitLag(pickup);
  if (!split) return { schemaVersion: 1, label, message: 'not measured yet', color: 'lightgrey' };
  return {
    schemaVersion: 1,
    label,
    message: formatLag(split.ours * 1000),
    color: 'informational'
  };
}

// buildBadges(status) -> { '<filename>.json': <shields payload> } per Data contract B. Pure.
function buildBadges(status) {
  const badges = {};

  for (const variant of VARIANTS) {
    const entry = status.packages[variant.name] || { latest: null };
    badges[`${BADGES_DIR}/${variantBadgeFile(variant.name)}`] = variantBadge(variant.name, entry.latest);
  }

  const { latestStable } = status.wordpress;
  badges[`${BADGES_DIR}/wordpress.json`] = {
    schemaVersion: 1,
    label: 'latest stable',
    message: latestStable === null ? 'none' : latestStable,
    color: latestStable === null ? 'lightgrey' : 'blue'
  };

  badges[`${BADGES_DIR}/pickup-lag.json`] = pickupBadge(status.pickup);
  badges[`${BADGES_DIR}/reaction-lag.json`] = reactionBadge(status.pickup);

  return badges;
}

// readPickup(statusFile) -> the `pickup` value from an existing status.json, or null if the file is
// absent, unparseable, or its `pickup` is not an object with a string `version`. Never throws.
function readPickup(statusFile) {
  let text;
  try {
    text = fs.readFileSync(statusFile, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const pickup = parsed && parsed.pickup;
  if (!pickup || typeof pickup !== 'object' || typeof pickup.version !== 'string') return null;
  return pickup;
}

// writeStatusFiles(rootDir, status) -> writes status.json and badges/<name>.json, creating badges/
// as needed. Throws on a real I/O failure - the caller decides whether that is fatal.
function writeStatusFiles(rootDir, status) {
  const write = (relativePath, obj) => {
    fs.writeFileSync(path.join(rootDir, relativePath), `${JSON.stringify(obj, null, 2)}\n`);
  };

  fs.mkdirSync(path.join(rootDir, BADGES_DIR), { recursive: true });

  write(STATUS_FILE, status);

  const badges = buildBadges(status);
  for (const [relativePath, payload] of Object.entries(badges)) {
    write(relativePath, payload);
  }
}

module.exports = { buildStatus, buildBadges, readPickup, writeStatusFiles, STATUS_FILE, BADGES_DIR };
