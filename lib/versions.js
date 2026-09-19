'use strict';

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

module.exports = { versionParts, compareVersions, findDuplicates };
