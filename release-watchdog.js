'use strict';

const fs = require('fs');

const { VARIANTS, probeBase } = require('./lib/constants');
const { readPackages, fetchOfferedVersions } = require('./check-new-versions');

const GRACE_MINUTES = Number(process.env.GRACE_MINUTES || 120);

// Age in minutes of the published archive, or null when it does not exist (yet)
async function archiveAgeMinutes(version, suffix) {
  const res = await fetch(`${probeBase()}wordpress-${version}${suffix}.zip`, { method: 'HEAD' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${version}${suffix}`);
  const modified = Date.parse(res.headers.get('last-modified'));
  if (Number.isNaN(modified)) throw new Error(`no Last-Modified for ${version}${suffix}`);
  return Math.floor((Date.now() - modified) / 60000);
}

async function main() {
  const packages = readPackages();
  const overdue = [];
  for (const version of await fetchOfferedVersions()) {
    for (const variant of VARIANTS) {
      if (Object.hasOwn(packages[variant.name], version)) continue;
      const age = await archiveAgeMinutes(version, variant.suffix);
      if (age !== null && age > GRACE_MINUTES) overdue.push(`${variant.name} ${version} (published ${age} min ago)`);
    }
  }

  const found = overdue.length > 0;
  for (const item of overdue) console.log(`::error::Release missing from packages.json: ${item}`);
  if (!found) console.log(`No offered release is missing for more than ${GRACE_MINUTES} min`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `overdue=${found}\n`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exitCode = 1;
});
