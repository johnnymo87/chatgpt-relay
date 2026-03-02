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
