'use strict';

// Pure exports only, no side effects at require time — Node's test runner
// also loads this file as a test file (it contains zero tests, harmlessly).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// routes: { [urlPath]: (req, res) => void }
function startServer(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes[url.pathname];
    if (!handler) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    handler(req, res, url);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve()))
      });
    });
  });
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-core-test-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

module.exports = { startServer, withTempDir, readFixture };
