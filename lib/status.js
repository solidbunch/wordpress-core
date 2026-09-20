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
    label: 'WordPress tracked',
    message: latestStable === null ? 'none' : latestStable,
    color: latestStable === null ? 'lightgrey' : 'blue'
  };

  const { pickup } = status;
  badges[`${BADGES_DIR}/pickup-lag.json`] = {
    schemaVersion: 1,
    label: 'pickup lag (last added version)',
    message: pickup === null ? 'not measured yet' : `${formatLag(pickup.lagSeconds * 1000)} (${pickup.version})`,
    color: pickup === null ? 'lightgrey' : 'informational'
  };

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
