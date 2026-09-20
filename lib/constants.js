'use strict';

const API_URL = 'https://api.wordpress.org/core/version-check/1.7/';
const STABLE_CHECK_URL = 'https://api.wordpress.org/core/stable-check/1.0/';
const VERSION_PHP_URLS = [
  (version) => `https://core.svn.wordpress.org/tags/${version}/wp-includes/version.php`,
  (version) => `https://raw.githubusercontent.com/WordPress/WordPress/${version}/wp-includes/version.php`
];
const DOWNLOAD_BASE = 'https://downloads.wordpress.org/release/';
const DOWNLOAD_HOST = 'downloads.wordpress.org';

// DOWNLOAD_BASE_OVERRIDE is a test seam; the workflows never set it
const probeBase = () => process.env.DOWNLOAD_BASE_OVERRIDE || DOWNLOAD_BASE;

// License of the WordPress archives the entries point to, not of this repository's own code
const LICENSE = 'GPL-2.0-or-later';

// Oldest branch ever published here; limits enumeration only
const MIN_VERSION = '4.1';

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;                          // stable only, unchanged meaning
const PRERELEASE_VERSION_RE = /^\d+\.\d+(\.\d+)?-(beta|RC)\d+$/;  // 6.9-beta1, 6.9-RC1, 6.9.1-RC2
const ANY_VERSION_RE = /^\d+\.\d+(\.\d+)?(-(beta|RC)\d+)?$/;
const SHASUM_RE = /^[0-9a-f]{40}$/;
const PHP_REQUIREMENT_RE = /^>=\d+\.\d+$/;

const REQUEST_TIMEOUT_MS = 15000;

const VARIANTS = [
  {
    name: 'solidbunch/wordpress-core-no-content',
    suffix: '-no-content',
    description: 'WordPress core without wp-content, the no-content release archive as published on wordpress.org',
    keywords: ['wordpress', 'core', 'cms', 'no-content'],
    hasSource: false
  },
  {
    name: 'solidbunch/wordpress-core',
    suffix: '',
    description: 'WordPress core, the full release archive as published on wordpress.org',
    keywords: ['wordpress', 'core', 'cms'],
    hasSource: true
  }
];

const HOMEPAGE = 'https://wordpress.org';
const SUPPORT = Object.freeze({
  issues: 'https://github.com/solidbunch/wordpress-core/issues',
  source: 'https://github.com/solidbunch/wordpress-core'
});
const CORE_IMPLEMENTATION = 'wordpress/core-implementation';
const SOURCE_URL = 'https://github.com/WordPress/WordPress.git';

module.exports = {
  API_URL,
  STABLE_CHECK_URL,
  VERSION_PHP_URLS,
  DOWNLOAD_BASE,
  DOWNLOAD_HOST,
  probeBase,
  LICENSE,
  MIN_VERSION,
  VERSION_RE,
  PRERELEASE_VERSION_RE,
  ANY_VERSION_RE,
  SHASUM_RE,
  PHP_REQUIREMENT_RE,
  REQUEST_TIMEOUT_MS,
  VARIANTS,
  HOMEPAGE,
  SUPPORT,
  CORE_IMPLEMENTATION,
  SOURCE_URL
};
