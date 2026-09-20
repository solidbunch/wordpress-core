'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, readFixture } = require('./helpers');
const { parseBadgeBlock, classifyBadge, checkBadge, formatReport } = require('../validate-badges');

const FIXTURE = readFixture('readme-badges.md');

// ---------------------------------------------------------------------------
// parseBadgeBlock
// ---------------------------------------------------------------------------

test('parseBadgeBlock: the fixture yields exactly 8 badges in order, with correct fields', () => {
  const badges = parseBadgeBlock(FIXTURE);
  assert.equal(badges.length, 8);
  assert.deepEqual(badges[0], {
    alt: 'CI',
    imageUrl: 'https://github.com/solidbunch/wordpress-core/actions/workflows/ci.yml/badge.svg?branch=main',
    linkUrl: 'https://github.com/solidbunch/wordpress-core/actions/workflows/ci.yml',
    line: 5
  });
  assert.equal(badges[7].alt, 'Pickup lag');
  // Every badge line must be one of the first eight; the decoy further down must not appear.
  assert.ok(badges.every((b) => !b.imageUrl.includes('example.com')));
});

test('parseBadgeBlock: a badge-looking line appearing later in the document is not included', () => {
  const badges = parseBadgeBlock(FIXTURE);
  assert.ok(!badges.some((b) => b.alt === 'x'));
});

test('parseBadgeBlock: a README with no badge block yields []', () => {
  assert.deepEqual(parseBadgeBlock('# Title\n\nJust prose, no badges here.\n'), []);
});

test('parseBadgeBlock: a blank line inside the block terminates it', () => {
  const text = [
    '[![A](https://example.com/a.svg)](https://example.com/a)',
    '',
    '[![B](https://example.com/b.svg)](https://example.com/b)'
  ].join('\n');
  const badges = parseBadgeBlock(text);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].alt, 'A');
});

// ---------------------------------------------------------------------------
// classifyBadge
// ---------------------------------------------------------------------------

test('classifyBadge: production shields URLs decode to the expected Pages target', () => {
  const names = ['wordpress-core', 'wordpress-core-no-content', 'wordpress', 'pickup-lag'];
  for (const name of names) {
    const imageUrl = `https://img.shields.io/endpoint?url=https%3A%2F%2Fsolidbunch.github.io%2Fwordpress-core%2Fbadges%2F${name}.json`;
    const classified = classifyBadge({ alt: name, imageUrl, linkUrl: 'https://example.com', line: 1 });
    assert.equal(classified.kind, 'shields');
    assert.equal(classified.targetUrl, `https://solidbunch.github.io/wordpress-core/badges/${name}.json`);
  }
});

test('classifyBadge: production native URLs classify as native', () => {
  const workflows = ['ci', 'update-packages', 'audit-checksums', 'keepalive'];
  for (const wf of workflows) {
    const imageUrl = `https://github.com/solidbunch/wordpress-core/actions/workflows/${wf}.yml/badge.svg?branch=main`;
    const classified = classifyBadge({ alt: wf, imageUrl, linkUrl: 'https://example.com', line: 1 });
    assert.equal(classified.kind, 'native');
    assert.equal(classified.targetUrl, imageUrl);
  }
});

test('classifyBadge: an unrecognised host classifies as unknown without throwing', () => {
  const classified = classifyBadge({ alt: 'x', imageUrl: 'https://example.com/foo.svg', linkUrl: 'https://example.com', line: 1 });
  assert.equal(classified.kind, 'unknown');
  assert.equal(classified.targetUrl, null);
});

test('classifyBadge: a malformed URL classifies as unknown without throwing', () => {
  const classified = classifyBadge({ alt: 'x', imageUrl: 'not a url', linkUrl: 'https://example.com', line: 1 });
  assert.equal(classified.kind, 'unknown');
  assert.equal(classified.targetUrl, null);
});

test('classifyBadge: shields endpoint with missing url= param classifies as unknown', () => {
  const classified = classifyBadge({ alt: 'x', imageUrl: 'https://img.shields.io/endpoint', linkUrl: 'https://example.com', line: 1 });
  assert.equal(classified.kind, 'unknown');
});

test('classifyBadge: shields endpoint with empty url= param classifies as unknown', () => {
  const classified = classifyBadge({ alt: 'x', imageUrl: 'https://img.shields.io/endpoint?url=', linkUrl: 'https://example.com', line: 1 });
  assert.equal(classified.kind, 'unknown');
});

// ---------------------------------------------------------------------------
// checkBadge — native, over startServer
// ---------------------------------------------------------------------------

test('checkBadge native: 200 image/svg+xml passes', async () => {
  const { url, close } = await startServer({
    '/badge.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg></svg>');
    }
  });
  try {
    const classified = { alt: 'X', imageUrl: `${url}/badge.svg`, linkUrl: url, line: 1, kind: 'native', targetUrl: `${url}/badge.svg` };
    const result = await checkBadge(classified);
    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].name, 'badge-image-check');
    assert.equal(result.checks[0].pass, true);
  } finally {
    await close();
  }
});

test('checkBadge native: 200 image/svg+xml; charset=utf-8 passes', async () => {
  const { url, close } = await startServer({
    '/badge.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' });
      res.end('<svg></svg>');
    }
  });
  try {
    const classified = { alt: 'X', imageUrl: `${url}/badge.svg`, linkUrl: url, line: 1, kind: 'native', targetUrl: `${url}/badge.svg` };
    const result = await checkBadge(classified);
    assert.equal(result.ok, true);
  } finally {
    await close();
  }
});

test('checkBadge native: 200 text/html fails, with the content-type named in detail', async () => {
  const { url, close } = await startServer({
    '/badge.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    }
  });
  try {
    const classified = { alt: 'X', imageUrl: `${url}/badge.svg`, linkUrl: url, line: 1, kind: 'native', targetUrl: `${url}/badge.svg` };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    assert.match(result.checks[0].detail, /text\/html/);
  } finally {
    await close();
  }
});

test('checkBadge native: 200 with Content-Type omitted entirely fails gracefully with "null" in detail', async () => {
  const { url, close } = await startServer({
    '/badge.svg': (req, res) => {
      // Explicitly avoid setting a Content-Type header, so res.headers.get('content-type') is null.
      res.writeHead(200, {});
      res.end('<svg></svg>');
    }
  });
  try {
    const classified = { alt: 'X', imageUrl: `${url}/badge.svg`, linkUrl: url, line: 1, kind: 'native', targetUrl: `${url}/badge.svg` };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    assert.match(result.checks[0].detail, /Content-Type is null/);
  } finally {
    await close();
  }
});

test('checkBadge native: 404 fails with HTTP 404 in detail', async () => {
  const { url, close } = await startServer({});
  try {
    const classified = { alt: 'X', imageUrl: `${url}/missing.svg`, linkUrl: url, line: 1, kind: 'native', targetUrl: `${url}/missing.svg` };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    assert.match(result.checks[0].detail, /HTTP 404/);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// checkBadge — Promise.all isolation
// ---------------------------------------------------------------------------

test('Promise.all(badges.map(checkBadge)) never rejects, even with a nasty failure mixed in', async () => {
  const { url, close } = await startServer({
    '/good.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg></svg>');
    },
    '/no-content-type.svg': (req, res) => {
      res.writeHead(200, {});
      res.end('<svg></svg>');
    }
  });
  try {
    const goodBadge = { alt: 'Good', imageUrl: `${url}/good.svg`, linkUrl: url, line: 1, kind: 'native', targetUrl: `${url}/good.svg` };
    const nastyBadge = { alt: 'Nasty', imageUrl: `${url}/no-content-type.svg`, linkUrl: url, line: 2, kind: 'native', targetUrl: `${url}/no-content-type.svg` };
    const forcedNullTargetBadge = { alt: 'Forced', imageUrl: `${url}/good.svg`, linkUrl: url, line: 3, kind: 'shields', targetUrl: null };
    const results = await Promise.all([goodBadge, nastyBadge, forcedNullTargetBadge].map(checkBadge));
    assert.equal(results.length, 3);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[2].alt, 'Forced');
    assert.equal(results[2].checks.length, 2);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// checkBadge — shields, both hops, over startServer, all four combinations
// ---------------------------------------------------------------------------

test('checkBadge shields: both hops pass -> ok true, two checks, both pass', async () => {
  const { url, close } = await startServer({
    '/endpoint.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg><title>label: value</title></svg>');
    },
    '/target.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 1, label: 'label', message: 'value' }));
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target.json`
    };
    const result = await checkBadge(classified);
    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 2);
    assert.ok(result.checks.every((c) => c.pass));
  } finally {
    await close();
  }
});

test('checkBadge shields: endpoint passes, target fails (404) -> today\'s production shape', async () => {
  const { url, close } = await startServer({
    '/endpoint.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg><title>custom badge: resource not found</title></svg>');
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target-missing.json`
    };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    const endpointCheck = result.checks.find((c) => c.name === 'shields-endpoint-check');
    const targetCheck = result.checks.find((c) => c.name === 'target-artifact-check');
    assert.equal(endpointCheck.pass, true);
    assert.equal(targetCheck.pass, false);
    assert.match(targetCheck.detail, /HTTP 404/);
  } finally {
    await close();
  }
});

test('checkBadge shields: endpoint fails (wrong media type), target passes', async () => {
  const { url, close } = await startServer({
    '/endpoint-broken.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>error</html>');
    },
    '/target.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 1, label: 'label', message: 'value' }));
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint-broken.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target.json`
    };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    const endpointCheck = result.checks.find((c) => c.name === 'shields-endpoint-check');
    const targetCheck = result.checks.find((c) => c.name === 'target-artifact-check');
    assert.equal(endpointCheck.pass, false);
    assert.equal(targetCheck.pass, true);
  } finally {
    await close();
  }
});

test('checkBadge shields: both hops fail', async () => {
  const { url, close } = await startServer({});
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint-missing.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target-missing.json`
    };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    assert.ok(result.checks.every((c) => !c.pass));
    assert.equal(result.checks[0].url, `${url}/endpoint-missing.svg`);
    assert.equal(result.checks[1].url, `${url}/target-missing.json`);
  } finally {
    await close();
  }
});

test('checkBadge shields: target payload missing message field fails', async () => {
  const { url, close } = await startServer({
    '/endpoint.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg></svg>');
    },
    '/target-no-message.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 1 }));
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target-no-message.json`
    };
    const result = await checkBadge(classified);
    const targetCheck = result.checks.find((c) => c.name === 'target-artifact-check');
    assert.equal(targetCheck.pass, false);
    assert.match(targetCheck.detail, /shields endpoint payload/);
  } finally {
    await close();
  }
});

test('checkBadge shields: target payload not JSON fails mentioning "not JSON"', async () => {
  const { url, close } = await startServer({
    '/endpoint.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg></svg>');
    },
    '/target-not-json.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target-not-json.json`
    };
    const result = await checkBadge(classified);
    const targetCheck = result.checks.find((c) => c.name === 'target-artifact-check');
    assert.equal(targetCheck.pass, false);
    assert.match(targetCheck.detail, /not JSON/);
  } finally {
    await close();
  }
});

test('checkBadge shields: target payload is an array fails', async () => {
  const { url, close } = await startServer({
    '/endpoint.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg></svg>');
    },
    '/target-array.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([1, 2, 3]));
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target-array.json`
    };
    const result = await checkBadge(classified);
    const targetCheck = result.checks.find((c) => c.name === 'target-artifact-check');
    assert.equal(targetCheck.pass, false);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// checkShieldsImageResponse title echo (via checkBadge, over startServer)
// ---------------------------------------------------------------------------

test('shields title echo is non-blocking: a 200 SVG with an error title still passes', async () => {
  const { url, close } = await startServer({
    '/endpoint.svg': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg role="img"><title>custom badge: resource not found</title></svg>');
    },
    '/target.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 1, label: 'label', message: 'value' }));
    }
  });
  try {
    const classified = {
      alt: 'X', imageUrl: `${url}/endpoint.svg`, linkUrl: url, line: 1,
      kind: 'shields', targetUrl: `${url}/target.json`
    };
    const result = await checkBadge(classified);
    const endpointCheck = result.checks.find((c) => c.name === 'shields-endpoint-check');
    assert.equal(endpointCheck.pass, true);
    assert.match(endpointCheck.detail, /custom badge: resource not found/);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// checkBadge — unknown
// ---------------------------------------------------------------------------

test('checkBadge unknown: fails without making any request', async () => {
  let hits = 0;
  const { url, close } = await startServer({
    '/never-hit.svg': (req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg></svg>');
    }
  });
  try {
    const classified = { alt: 'X', imageUrl: `${url}/never-hit.svg`, linkUrl: url, line: 1, kind: 'unknown', targetUrl: null };
    const result = await checkBadge(classified);
    assert.equal(result.ok, false);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].name, 'classification');
    assert.equal(hits, 0);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

test('formatReport: a failing shields result produces two indented check lines with both URLs and details', () => {
  const results = [{
    alt: 'WordPress tracked', imageUrl: 'http://x/endpoint.svg', linkUrl: 'http://x', line: 9,
    kind: 'shields', targetUrl: 'http://x/target.json', ok: false,
    checks: [
      { name: 'shields-endpoint-check', url: 'http://x/endpoint.svg', pass: true, detail: '200, image/svg+xml' },
      { name: 'target-artifact-check', url: 'http://x/target.json', pass: false, detail: 'HTTP 404: not found' }
    ]
  }];
  const { lines, summary, failed } = formatReport(results);
  assert.equal(failed, 1);
  assert.equal(lines[0], 'FAIL: WordPress tracked [shields] line 9: http://x/endpoint.svg');
  assert.ok(lines.some((l) => l.includes('shields-endpoint-check: PASS') && l.includes('http://x/endpoint.svg')));
  assert.ok(lines.some((l) => l.includes('target-artifact-check: FAIL') && l.includes('http://x/target.json') && l.includes('HTTP 404: not found')));
  assert.match(summary, /CHECKED 1 badge: 0 ok, 1 failed \(2 checks: 1 passed, 1 failed\)/);
});

test('formatReport: a failing native result names the URL and the received detail', () => {
  const results = [{
    alt: 'CI', imageUrl: 'http://x/ci.svg', linkUrl: 'http://x', line: 5,
    kind: 'native', targetUrl: 'http://x/ci.svg', ok: false,
    checks: [{ name: 'badge-image-check', url: 'http://x/ci.svg', pass: false, detail: 'HTTP 404: Not Found' }]
  }];
  const { lines } = formatReport(results);
  assert.equal(lines[0], 'FAIL: CI [native] line 5: http://x/ci.svg');
  assert.ok(lines[1].includes('HTTP 404: Not Found'));
});

test('formatReport: summary counts badges and checks correctly across a mixed batch', () => {
  const okBadge = {
    alt: 'A', imageUrl: 'http://x/a.svg', linkUrl: 'http://x', line: 1, kind: 'native', targetUrl: 'http://x/a.svg',
    ok: true, checks: [{ name: 'badge-image-check', url: 'http://x/a.svg', pass: true, detail: '200, image/svg+xml' }]
  };
  const failBadge = {
    alt: 'B', imageUrl: 'http://x/b.svg', linkUrl: 'http://x', line: 2, kind: 'shields', targetUrl: 'http://x/b.json',
    ok: false, checks: [
      { name: 'shields-endpoint-check', url: 'http://x/b.svg', pass: true, detail: '200, image/svg+xml' },
      { name: 'target-artifact-check', url: 'http://x/b.json', pass: false, detail: 'HTTP 404: not found' }
    ]
  };
  const { summary, failed } = formatReport([okBadge, failBadge]);
  assert.equal(failed, 1);
  assert.equal(summary, 'CHECKED 2 badges: 1 ok, 1 failed (3 checks: 2 passed, 1 failed)');
});
