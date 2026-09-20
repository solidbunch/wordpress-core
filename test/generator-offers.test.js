'use strict';

// Offline tests for the generator's beta-channel merge (T3.2, backlog 3.1/3.4). fetchOffers() reads
// process.env.API_URL_OVERRIDE through apiUrl() (a function, not a require-time snapshot), so each
// test below points it at its own local server just before calling fetchOffers()/fetchBetaOffers().

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchOffers, fetchBetaOffers, fetchStableVersions } = require('../generate-packages-json');
const { startServer } = require('./helpers');

// Handlers receive the parsed URL as a third argument (see test/helpers.js), so a single route can
// tell the stable request (no "channel" query param) apart from the beta one (channel=beta).
function offersServer({ stable, beta }) {
  return startServer({
    '/version-check': (req, res, url) => {
      const handler = url.searchParams.get('channel') === 'beta' ? beta : stable;
      handler(req, res, url);
    }
  });
}

function jsonRoute(status, body) {
  return (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

function textRoute(status, body) {
  return (req, res) => {
    res.writeHead(status);
    res.end(body);
  };
}

async function withEnvVar(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const withApiUrl = (url, fn) => withEnvVar('API_URL_OVERRIDE', url, fn);
const withStableCheckUrl = (url, fn) => withEnvVar('STABLE_CHECK_URL_OVERRIDE', url, fn);

test('fetchOffers: a beta offer is merged with the stable offers', async () => {
  const { url, close } = await offersServer({
    stable: jsonRoute(200, { offers: [{ version: '6.9', php_version: '7.4.33' }] }),
    beta: jsonRoute(200, { offers: [{ version: '7.0-RC1', php_version: '8.0.0' }] })
  });
  try {
    await withApiUrl(`${url}/version-check`, async () => {
      const { byVersion, ignored } = await fetchOffers();
      assert.equal(byVersion.size, 2);
      assert.equal(byVersion.get('6.9').php_version, '7.4.33');
      assert.equal(byVersion.get('7.0-RC1').php_version, '8.0.0');
      assert.deepEqual(ignored, []);
    });
  } finally {
    await close();
  }
});

test('fetchOffers: beta channel 500 -> BETA-CHANNEL-UNAVAILABLE logged, stable offers still used', async () => {
  const { url, close } = await offersServer({
    stable: jsonRoute(200, { offers: [{ version: '6.9', php_version: '7.4.33' }] }),
    beta: textRoute(500, 'boom')
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    await withApiUrl(`${url}/version-check`, async () => {
      const { byVersion, ignored } = await fetchOffers();
      assert.equal(byVersion.size, 1);
      assert.equal(byVersion.get('6.9').php_version, '7.4.33');
      assert.deepEqual(ignored, []);
    });
  } finally {
    console.log = originalLog;
    await close();
  }
  assert.ok(logs.some((line) => /^BETA-CHANNEL-UNAVAILABLE: cannot fetch .*version-check\?channel=beta: HTTP 500/.test(line)), logs.join('\n'));
});

test('fetchOffers: beta channel returns {"offers":"nonsense"} -> same graceful handling', async () => {
  const { url, close } = await offersServer({
    stable: jsonRoute(200, { offers: [{ version: '6.9', php_version: '7.4.33' }] }),
    beta: jsonRoute(200, { offers: 'nonsense' })
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    await withApiUrl(`${url}/version-check`, async () => {
      const { byVersion } = await fetchOffers();
      assert.equal(byVersion.size, 1);
      assert.equal(byVersion.get('6.9').php_version, '7.4.33');
    });
  } finally {
    console.log = originalLog;
    await close();
  }
  assert.ok(logs.some((line) => /^BETA-CHANNEL-UNAVAILABLE: .*version-check\?channel=beta returned no "offers" array$/.test(line)), logs.join('\n'));
});

test('fetchOffers: same version on both channels -> one entry, stable offer wins', async () => {
  const { url, close } = await offersServer({
    stable: jsonRoute(200, { offers: [{ version: '6.9', php_version: '7.4.33', source: 'stable' }] }),
    beta: jsonRoute(200, { offers: [{ version: '6.9', php_version: '8.1.0', source: 'beta' }] })
  });
  try {
    await withApiUrl(`${url}/version-check`, async () => {
      const { byVersion } = await fetchOffers();
      assert.equal(byVersion.size, 1);
      assert.equal(byVersion.get('6.9').source, 'stable');
    });
  } finally {
    await close();
  }
});

test('fetchStableVersions: a prerelease-looking key is IGNORED-VERSION, enumeration stays stable-only', async () => {
  const { url, close } = await startServer({
    '/stable-check': jsonRoute(200, { '6.9': 'latest', '6.9-RC1': 'outdated' })
  });
  try {
    await withStableCheckUrl(`${url}/stable-check`, async () => {
      const { versions, ignored } = await fetchStableVersions();
      assert.deepEqual(versions, ['6.9']);
      assert.deepEqual(ignored, ['IGNORED-VERSION: "6.9-RC1" (from stable-check)']);
    });
  } finally {
    await close();
  }
});

test('fetchBetaOffers: a network error never throws and yields no offers', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    await withApiUrl('http://127.0.0.1:1/version-check', async () => {
      const offers = await fetchBetaOffers();
      assert.deepEqual(offers, []);
    });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some((line) => line.startsWith('BETA-CHANNEL-UNAVAILABLE: ')), logs.join('\n'));
});
