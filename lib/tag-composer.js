'use strict';

// The tag `composer.json` published in each package's own repository (see plan T7.1/T7.2) is exactly
// the corresponding `packages.json` entry (contract C1), deep-cloned so the same key order is
// guaranteed to be committed at tag time. Two deliberate deviations from general Composer guidance,
// both decided and recorded here before any tag exists (tags cannot be redone):
//
// 1. The explicit `version` field is kept even though Composer generally discourages a fixed
//    `version` in a tagged manifest (it usually lets the VCS tag imply the version). It is kept here
//    because it matches the verified layout of the established WordPress core Composer packages this
//    project mirrors.
//
// 2. Packagist preserving a custom `dist.url`/`dist.shasum` declared in a tag's `composer.json`,
//    instead of overwriting it with an auto-generated GitHub zipball URL, is long-standing observed
//    behaviour but is NOT documented by Packagist. If that behaviour ever changes, consumers would
//    silently fall back to a GitHub zipball of a repository that contains nothing but this manifest
//    file, which would be wrong (there is no WordPress source in that repository). That risk is
//    accepted and recorded here rather than worked around, because there is no supported alternative
//    that keeps the archive `dist.url` pointed at wordpress.org.

function buildTagComposerJson(variant, entry) {
  return JSON.parse(JSON.stringify(entry));
}

function serializeTagComposerJson(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

module.exports = { buildTagComposerJson, serializeTagComposerJson };
