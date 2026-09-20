'use strict';

// Offline tests for the PUBLISH_TOKEN -> authenticated remote substitution (plan T7.3, backlog 7.3).
//
// SECURITY: this file exercises secret-handling code. No assertion here ever prints the fixture
// token value via console.log/console.error - every check on the substituted URL is a direct
// node:assert comparison inside this process (never echoed), and the test that intentionally
// triggers a git command failure captures the *real* combined stdout+stderr of a standalone outer
// subprocess (via spawnSync, not execFileSync - see that test for why) and asserts the fixture
// token does NOT appear anywhere in it, exactly like a real CI log would show.
// FIXTURE_TOKEN is a fake value used only inside this file; it grants no access to anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const child_process = require('child_process');
const { execFileSync, spawnSync } = child_process;

const { withTempDir } = require('./helpers');

const MODULE_PATH = require.resolve('../publish-packages');
const FIXTURE_TOKEN = 'ghp_fixtureTOKENvalueNEVERreal0000000001';

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Reloads publish-packages.js with PUBLISH_TOKEN set to `token` (or unset when `token` is
// undefined) for the duration of `fn`, then restores the previous env and module cache state so
// other test files (and later tests in this file) are unaffected.
function withPublishModule(token, fn) {
  const previous = process.env.PUBLISH_TOKEN;
  if (token === undefined) delete process.env.PUBLISH_TOKEN;
  else process.env.PUBLISH_TOKEN = token;
  delete require.cache[MODULE_PATH];
  try {
    return fn(require('../publish-packages'));
  } finally {
    if (previous === undefined) delete process.env.PUBLISH_TOKEN;
    else process.env.PUBLISH_TOKEN = previous;
    delete require.cache[MODULE_PATH];
  }
}

test('resolveRemote: plain https://github.com remote + PUBLISH_TOKEN -> authenticated form', () => {
  withPublishModule(FIXTURE_TOKEN, ({ resolveRemote }) => {
    const result = resolveRemote('https://github.com/solidbunch/wordpress-core.git');
    assert.equal(result.url, `https://x-access-token:${FIXTURE_TOKEN}@github.com/solidbunch/wordpress-core.git`);
    assert.equal(result.label, 'solidbunch/wordpress-core');
  });
});

test('resolveRemote: PUBLISH_TOKEN unset leaves a plain github remote unchanged (existing behaviour)', () => {
  withPublishModule(undefined, ({ resolveRemote }) => {
    const result = resolveRemote('https://github.com/solidbunch/wordpress-core.git');
    assert.equal(result.url, 'https://github.com/solidbunch/wordpress-core.git');
    assert.equal(result.label, 'solidbunch/wordpress-core');
  });
});

test('resolveRemote: a non-GitHub remote (e.g. a local bare repo path or another host) is left unchanged', () => {
  withPublishModule(FIXTURE_TOKEN, ({ resolveRemote }) => {
    const bareRepoPath = '/tmp/some/bare/repo.git';
    const local = resolveRemote(bareRepoPath);
    assert.equal(local.url, bareRepoPath);
    assert.equal(local.label, undefined);

    const otherHost = resolveRemote('https://gitlab.com/solidbunch/wordpress-core.git');
    assert.equal(otherHost.url, 'https://gitlab.com/solidbunch/wordpress-core.git');
    assert.equal(otherHost.label, undefined);
  });
});

test('resolveRemote: an already-authenticated remote is left unchanged', () => {
  withPublishModule(FIXTURE_TOKEN, ({ resolveRemote }) => {
    const alreadyAuthed = 'https://x-access-token:some-other-token@github.com/solidbunch/wordpress-core.git';
    const result = resolveRemote(alreadyAuthed);
    assert.equal(result.url, alreadyAuthed);
    assert.equal(result.label, undefined);
  });
});

test(
  'resolveRemote output is a real, usable git remote: the authenticated URL round-trips through git remote add/get-url',
  { skip: !hasGit() },
  async () => {
    await withTempDir(async (dir) => {
      await withPublishModule(FIXTURE_TOKEN, ({ resolveRemote }) => {
        const { url } = resolveRemote('https://github.com/solidbunch/wordpress-core.git');
        execFileSync('git', ['init', '--quiet', dir]);
        execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
        const actual = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).trim();
        // In-process comparison only - this value is never passed to console.log/console.error.
        assert.equal(actual, url);
        assert.equal(actual, `https://x-access-token:${FIXTURE_TOKEN}@github.com/solidbunch/wordpress-core.git`);
      });
    });
  }
);

test('sanitizeGitError strips PUBLISH_TOKEN and the x-access-token credential shape from an error message', () => {
  withPublishModule(FIXTURE_TOKEN, ({ sanitizeGitError }) => {
    const raw =
      `Command failed: git clone --quiet https://x-access-token:${FIXTURE_TOKEN}@github.com/solidbunch/wordpress-core.git /tmp/x\n` +
      `fatal: could not read Username for 'https://x-access-token:${FIXTURE_TOKEN}@github.com': terminal prompts disabled`;
    const sanitized = sanitizeGitError(raw);
    assert.doesNotMatch(sanitized, new RegExp(FIXTURE_TOKEN));
    assert.match(sanitized, /x-access-token:\*\*\*@github\.com/);
  });
});

test('git() always forces stdio to [\'ignore\', \'pipe\', \'pipe\'] on every execFileSync call, regardless of caller-supplied opts', () => {
  // Directly proves the MECHANISM of the fix - that git()'s wrapper around execFileSync forces
  // stdio itself - rather than relying on git's own (version-dependent) stderr redaction behaviour
  // to incidentally hide the fact that stdio was not forced. This makes the test fail if the forced
  // `stdio` override in git() is ever silently reverted or weakened (e.g. merged with `opts` instead
  // of overriding it), independent of what any particular git version prints on failure.
  const original = child_process.execFileSync;
  const calls = [];
  child_process.execFileSync = (...args) => {
    calls.push(args);
    return Buffer.from('');
  };
  try {
    withPublishModule(FIXTURE_TOKEN, ({ runGit }) => {
      // Caller-supplied opts deliberately include a conflicting stdio value and an unrelated option,
      // to prove git() overrides rather than merges the caller's stdio.
      runGit(['status'], { encoding: 'utf8', stdio: 'inherit' });
      runGit(['log']);
    });
  } finally {
    child_process.execFileSync = original;
  }
  assert.equal(calls.length, 2);
  for (const [command, args, options] of calls) {
    assert.equal(command, 'git');
    assert.ok(Array.isArray(args));
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  }
});

test(
  'a failing git command never leaks PUBLISH_TOKEN into the error that would be logged, in-process',
  { skip: !hasGit() },
  () => {
    withPublishModule(FIXTURE_TOKEN, ({ runGit }) => {
      // Loopback, closed port: fails fast (connection refused) with no external network access,
      // while still exercising the real execFileSync failure path with a token embedded in the URL.
      const url = `https://x-access-token:${FIXTURE_TOKEN}@127.0.0.1:1/nope.git`;
      assert.throws(
        () => runGit(['ls-remote', '--heads', url], { encoding: 'utf8' }),
        (err) => {
          assert.doesNotMatch(err.message, new RegExp(FIXTURE_TOKEN));
          return true;
        }
      );
    });
  }
);

test(
  'positive check: real captured stdout+stderr of a failing git operation with PUBLISH_TOKEN set ' +
    'never contains the fixture token anywhere, including git\'s own raw stderr',
  { skip: !hasGit() },
  () => {
    // A standalone outer child process (spawned via execFileSync, real fd 1/2, not the in-process
    // node:test runner) that requires publish-packages.js and calls runGit() - the actual
    // git()-invoking code path, not a re-implementation of it - against an unreachable host
    // (loopback, closed port), so a real git fatal error is actually produced. Before the stdio fix
    // in publish-packages.js's git() wrapper, execFileSync's own default `inheritStderr` behaviour
    // would write git's raw, unsanitized stderr (containing the token-bearing remote URL) straight
    // to this outer process's real stderr, bypassing sanitizeGitError() entirely and this test's
    // `captured` variable would never see it - which is exactly the gap this test must catch.
    const childScript = `
      const { runGit } = require(${JSON.stringify(MODULE_PATH)});
      try {
        runGit(['ls-remote', '--heads', 'https://x-access-token:' + process.env.PUBLISH_TOKEN + '@127.0.0.1:1/nope.git']);
      } catch (err) {
        // Mirrors the CLI's own FATAL catch block (require.main === module): only the
        // already-sanitized message is ever printed, never the raw one.
        console.log('FATAL: ' + err.message);
      }
    `;
    // spawnSync (not execFileSync) on the *outer* call, with stdio: ['ignore', 'pipe', 'pipe']: unlike
    // execFileSync - which only ever returns the child's stdout and silently discards a
    // *successfully-exited* child's stderr even when it is piped (verified: an explicit `stdio: 'pipe'`
    // still drops stderr from execFileSync's return value on exit code 0) - spawnSync always returns
    // both `stdout` and `stderr` as captured buffers/strings regardless of the child's exit code. That
    // is required here: both streams of the outer process must be inspected explicitly, because before
    // the git() stdio fix, git's raw stderr would have surfaced on the outer process's real stderr
    // (bypassing `console.log` and any stdout capture entirely).
    const result = spawnSync(process.execPath, ['-e', childScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PUBLISH_TOKEN: FIXTURE_TOKEN }
    });
    assert.equal(result.status, 0, `child process exited non-zero: ${result.stderr}`);
    const captured = (result.stdout || '') + (result.stderr || '');
    assert.match(captured, /FATAL: /);
    assert.doesNotMatch(captured, new RegExp(FIXTURE_TOKEN));
    // Stronger, version-independent signal than substring-matching the token: with the stdio fix in
    // place, execFileSync never inherits git's raw stderr into this outer process's real stderr for
    // this scenario, so the raw stream must be entirely empty - not merely token-free. Before the
    // fix, git's raw fatal message (including the token-bearing URL) lands here verbatim, so this
    // assertion fails for the reverted/buggy `git()` even on git versions whose own fatal-message
    // text happens not to echo the token back.
    assert.equal(result.stderr, '', `expected no raw git stderr to leak into the outer process, got: ${result.stderr}`);
  }
);
