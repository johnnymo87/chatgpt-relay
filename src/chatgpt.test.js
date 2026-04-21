import { test } from 'node:test';
import assert from 'node:assert';
import { isLoggedIn } from './chatgpt.js';

/**
 * Create a mock Playwright page object for testing isLoggedIn.
 *
 * The real isLoggedIn races two locators via waitFor -- whichever
 * resolves first wins.  This mock simulates that by resolving
 * the "visible" locator immediately and letting the other hang
 * until timeout (which isLoggedIn handles internally).
 *
 * @param {object} opts
 * @param {string} opts.url - The current page URL
 * @param {'login'|'loggedIn'|'neither'} opts.winner - Which signal appears first
 */
function mockPage({ url = 'https://chatgpt.com/', winner = 'neither' } = {}) {
  return {
    url: () => url,
    locator: (selector) => {
      const isLoginSelector = selector.includes('Log in') ||
        selector.includes('Sign in') || selector.includes('/auth');

      return {
        first: () => ({
          waitFor: ({ timeout } = {}) => {
            if (isLoginSelector && winner === 'login') return Promise.resolve();
            if (!isLoginSelector && winner === 'loggedIn') return Promise.resolve();
            // Simulate element never appearing -- hang then reject (like Playwright timeout).
            // Use a short timeout so tests don't actually wait.
            return new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 50)
            );
          },
          isVisible: async () => {
            if (isLoginSelector) return winner === 'login';
            return winner === 'loggedIn';
          }
        })
      };
    }
  };
}

test('isLoggedIn returns false when URL contains /auth', async () => {
  const page = mockPage({ url: 'https://auth0.openai.com/auth/login' });
  assert.strictEqual(await isLoggedIn(page), false);
});

test('isLoggedIn returns false when URL contains login.openai.com', async () => {
  const page = mockPage({ url: 'https://login.openai.com/authorize' });
  assert.strictEqual(await isLoggedIn(page), false);
});

test('isLoggedIn returns false when login button appears', async () => {
  const page = mockPage({ winner: 'login' });
  assert.strictEqual(await isLoggedIn(page), false);
});

test('isLoggedIn returns true when logged-in indicator appears', async () => {
  const page = mockPage({ winner: 'loggedIn' });
  assert.strictEqual(await isLoggedIn(page), true);
});

test('isLoggedIn returns false when neither signal appears (ambiguous/timeout)', async () => {
  const page = mockPage({ winner: 'neither' });
  assert.strictEqual(await isLoggedIn(page), false);
});

test('isLoggedIn returns false when login button visible even if indicator also visible', async () => {
  // Edge case: both appear. Login button takes priority (not logged in).
  const page = {
    url: () => 'https://chatgpt.com/',
    locator: (selector) => ({
      first: () => ({
        waitFor: async () => {}, // Both resolve immediately
        isVisible: async () => true
      })
    })
  };
  assert.strictEqual(await isLoggedIn(page), false);
});

test('loginButton selector does NOT include broad a[href*="/auth"] match', async () => {
  // Regression: deep-research responses can include citation anchors with
  // /auth in the href (e.g., GitHub Docs links to /auth pages). Previously
  // these false-matched the loginButton selector and caused isLoggedIn to
  // return false AFTER a successful long generation, throwing a spurious
  // "Not logged in" error. The compound loginButton selector must not
  // include any anchor selector that matches arbitrary content links.
  // We re-import the source as a string and assert.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('./chatgpt.js', import.meta.url)),
    'utf8'
  );

  // Find the loginButton: [ ... ] block and inspect its contents.
  const match = src.match(/loginButton:\s*\[([\s\S]*?)\]\.join/);
  assert.ok(match, 'Could not locate loginButton selector array in source');
  const block = match[1];

  // Must not contain the bare a[href*="/auth"] selector that caused the
  // false-positive. (Allow comments mentioning it for documentation.)
  // Strip line comments before checking.
  const codeOnly = block.split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !/a\[href\*=["']\/auth["']\]/.test(codeOnly),
    'loginButton must not include a[href*="/auth"] -- it false-matches ' +
    'citation anchors in deep-research responses'
  );
});
