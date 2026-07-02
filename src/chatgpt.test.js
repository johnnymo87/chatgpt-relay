import { test } from 'node:test';
import assert from 'node:assert';
import {
  isLoggedIn,
  loginStatus,
  ensureLoggedInAtStartup,
  navigateToNewChat,
} from './chatgpt.js';

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

/**
 * Like mockPage, but its "winner" can change across page.reload() calls so we
 * can exercise the startup retry loop. `winners` is the sequence of states;
 * each reload() advances to the next entry (clamped to the last).
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {Array<'login'|'loggedIn'|'neither'>} opts.winners
 */
function mockStatefulPage({ url = 'https://chatgpt.com/', winners = ['neither'] } = {}) {
  let idx = 0;
  const page = {
    reloadCount: 0,
    url: () => url,
    reload: async () => {
      page.reloadCount++;
      idx = Math.min(idx + 1, winners.length - 1);
    },
    locator: (selector) => {
      const isLoginSelector = selector.includes('Log in') ||
        selector.includes('Sign in') || selector.includes('/auth');
      return {
        first: () => ({
          waitFor: ({ timeout } = {}) => {
            const winner = winners[idx];
            if (isLoginSelector && winner === 'login') return Promise.resolve();
            if (!isLoginSelector && winner === 'loggedIn') return Promise.resolve();
            return new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), 50)
            );
          },
          isVisible: async () => {
            const winner = winners[idx];
            if (isLoginSelector) return winner === 'login';
            return winner === 'loggedIn';
          }
        })
      };
    }
  };
  return page;
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

// --- loginStatus: distinguishes logged-out from ambiguous/unknown ---

test('loginStatus returns "logged-out" when URL is an auth redirect', async () => {
  const page = mockPage({ url: 'https://auth0.openai.com/auth/login' });
  assert.strictEqual(await loginStatus(page), 'logged-out');
});

test('loginStatus returns "logged-out" when login button appears', async () => {
  const page = mockPage({ winner: 'login' });
  assert.strictEqual(await loginStatus(page), 'logged-out');
});

test('loginStatus returns "logged-in" when logged-in indicator appears', async () => {
  const page = mockPage({ winner: 'loggedIn' });
  assert.strictEqual(await loginStatus(page), 'logged-in');
});

test('loginStatus returns "unknown" when neither signal appears (timeout)', async () => {
  const page = mockPage({ winner: 'neither' });
  assert.strictEqual(await loginStatus(page), 'unknown');
});

// --- ensureLoggedInAtStartup: retries on ambiguous, fails fast on logged-out ---

test('ensureLoggedInAtStartup returns true immediately when logged in (no reload)', async () => {
  const page = mockStatefulPage({ winners: ['loggedIn'] });
  assert.strictEqual(await ensureLoggedInAtStartup(page), true);
  assert.strictEqual(page.reloadCount, 0);
});

test('ensureLoggedInAtStartup fails fast when definitively logged out (no reload)', async () => {
  const page = mockStatefulPage({ winners: ['login'] });
  assert.strictEqual(await ensureLoggedInAtStartup(page, { attempts: 3 }), false);
  assert.strictEqual(page.reloadCount, 0);
});

test('ensureLoggedInAtStartup retries on "unknown" and succeeds after a reload', async () => {
  // Slow load: ambiguous on first check, hydrated (logged in) after one reload.
  const page = mockStatefulPage({ winners: ['neither', 'loggedIn'] });
  assert.strictEqual(await ensureLoggedInAtStartup(page, { attempts: 3 }), true);
  assert.strictEqual(page.reloadCount, 1);
});

test('ensureLoggedInAtStartup returns false after exhausting attempts when always ambiguous', async () => {
  const page = mockStatefulPage({ winners: ['neither'] });
  assert.strictEqual(await ensureLoggedInAtStartup(page, { attempts: 3 }), false);
  // Reloads happen between attempts only: after attempt 1 and 2, not after 3.
  assert.strictEqual(page.reloadCount, 2);
});

test('navigateToNewChat forces root navigation even when already at ChatGPT root', async () => {
  let gotoCount = 0;
  const page = {
    url: () => 'https://chatgpt.com/',
    goto: async (url) => {
      gotoCount++;
      assert.strictEqual(url, 'https://chatgpt.com');
    },
    waitForLoadState: async (state) => {
      assert.strictEqual(state, 'domcontentloaded');
    },
    locator: () => ({
      first: () => ({
        waitFor: async () => {}
      })
    })
  };

  await navigateToNewChat(page);

  assert.strictEqual(gotoCount, 1);
});
