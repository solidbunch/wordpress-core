'use strict';

const { PRERELEASE_VERSION_RE } = require('./constants');

const STAGE_RANK = { beta: 1, RC: 2, stable: 3 };

function versionParts(version) {
  const parts = version.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

// Parses a stable or prerelease version key into { parts, stage, stageRank, stageNumber }.
// Returns null for anything that is not a valid stable or prerelease version (see C2 in the plan).
function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const prereleaseMatch = version.match(PRERELEASE_VERSION_RE);
  if (prereleaseMatch) {
    const [base, stagePart] = version.split('-');
    const stage = stagePart.startsWith('beta') ? 'beta' : 'RC';
    const stageNumber = Number(stagePart.slice(stage.length));
    return {
      parts: versionParts(base),
      stage,
      stageRank: STAGE_RANK[stage],
      stageNumber
    };
  }
  const stableMatch = version.match(/^\d+\.\d+(\.\d+)?$/);
  if (stableMatch) {
    return { parts: versionParts(version), stage: 'stable', stageRank: STAGE_RANK.stable, stageNumber: 0 };
  }
  return null;
}

function isPrerelease(version) {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.stage !== 'stable';
}

// Compares parts[0..2], then stageRank (beta < RC < stable), then stageNumber. Throws on an
// unparseable input - callers only ever pass already-validated keys.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`compareVersions: unparseable version ${JSON.stringify(!pa ? a : b)}`);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  }
  if (pa.stageRank !== pb.stageRank) return pa.stageRank - pb.stageRank;
  return pa.stageNumber - pb.stageNumber;
}

// The canonical identity of a version for duplicate detection: "6.9-RC1" and "6.9.0-RC1" collapse
// to the same string, exactly as "6.9" and "6.9.0" already do for stable versions.
function canonicalVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`canonicalVersion: unparseable version ${JSON.stringify(version)}`);
  const base = parsed.parts.join('.');
  return parsed.stage === 'stable' ? base : `${base}-${parsed.stage}${parsed.stageNumber}`;
}

// "4.1" and "4.1.0" are the same Composer version, so equal-comparing keys are duplicates
function findDuplicates(versions) {
  const seen = new Map();
  const duplicates = [];
  for (const version of versions) {
    const canonical = canonicalVersion(version);
    if (seen.has(canonical)) duplicates.push(`DUPLICATE-VERSION: ${seen.get(canonical)} == ${version}`);
    else seen.set(canonical, version);
  }
  return duplicates;
}

module.exports = { versionParts, parseVersion, isPrerelease, compareVersions, canonicalVersion, findDuplicates };
