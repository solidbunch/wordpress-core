'use strict';

const { DOWNLOAD_BASE, DOWNLOAD_HOST } = require('./constants');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const distUrl = (variant, version) => `${DOWNLOAD_BASE}wordpress-${version}${variant.suffix}.zip`;

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

module.exports = { isObject, sleep, distUrl, normalizeHost };
