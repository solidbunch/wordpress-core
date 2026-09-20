'use strict';

const fs = require('fs');

const { VARIANTS } = require('./constants');
const { isObject } = require('./util');

function parsePackages(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
  if (!isObject(parsed) || !isObject(parsed.packages)) throw new Error(`${label} has no "packages" object`);
  const known = VARIANTS.map((variant) => variant.name);
  for (const name of Object.keys(parsed.packages)) {
    if (!known.includes(name)) throw new Error(`${label} contains unknown package ${name}`);
    if (!isObject(parsed.packages[name])) throw new Error(`${label}: package ${name} is not an object`);
  }
  return parsed.packages;
}

function readPackagesFile(path, { required }) {
  if (!fs.existsSync(path)) {
    if (required) throw new Error(`${path} does not exist`);
    return {};
  }
  return parsePackages(fs.readFileSync(path, 'utf8'), path);
}

module.exports = { parsePackages, readPackagesFile };
