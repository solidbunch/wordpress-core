'use strict';

const API_URL = 'https://api.wordpress.org/core/version-check/1.7/';
const STABLE_CHECK_URL = 'https://api.wordpress.org/core/stable-check/1.0/';
const VERSION_PHP_URLS = [
  (version) => `https://core.svn.wordpress.org/tags/${version}/wp-includes/version.php`,
  (version) => `https://raw.githubusercontent.com/WordPress/WordPress/${version}/wp-includes/version.php`
];
const DOWNLOAD_BASE = 'https://downloads.wordpress.org/release/';
const DOWNLOAD_HOST = 'downloads.wordpress.org';

// License of the WordPress archives the entries point to, not of this repository's own code
const LICENSE = 'GPL-2.0-or-later';

// Oldest branch ever published here; limits enumeration only
const MIN_VERSION = '4.1';

const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;
const SHASUM_RE = /^[0-9a-f]{40}$/;
const PHP_REQUIREMENT_RE = /^>=\d+\.\d+$/;

const REQUEST_TIMEOUT_MS = 15000;

const VARIANTS = [
  { name: 'solidbunch/wordpress-core-no-content', suffix: '-no-content' },
  { name: 'solidbunch/wordpress-core', suffix: '' }
];

module.exports = {
  API_URL,
  STABLE_CHECK_URL,
  VERSION_PHP_URLS,
  DOWNLOAD_BASE,
  DOWNLOAD_HOST,
  LICENSE,
  MIN_VERSION,
  VERSION_RE,
  SHASUM_RE,
  PHP_REQUIREMENT_RE,
  REQUEST_TIMEOUT_MS,
  VARIANTS
};
