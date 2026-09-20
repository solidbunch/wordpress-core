'use strict';

const { createHash } = require('crypto');

const MD5_RE = /^[0-9a-f]{32}$/;

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex');
const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

module.exports = { sha1, md5, MD5_RE };
