#!/usr/bin/env node

/**
 * ChatGPT Login Helper
 *
 * Launches a headed browser for one-time login, then saves the session
 * (cookies + localStorage) to a storage state file. The daemon can then
 * run headless using this saved state.
 */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const STORAGE_STATE_FILE = process.env.ASK_QUESTION_STORAGE_STATE_FILE ||
  path.join(os.homedir(), '.chatgpt-relay/storage-state.json');

const CHATGPT_URL = 'https://chatgpt.com';

async function main() {
  // Ensure storage directory exists
  fs.mkdirSync(path.dirname(STORAGE_STATE_FILE), { recursive: true });

  console.log('[ask-question-login] Launching browser for login...');
  console.log('[ask-question-login] Log into ChatGPT. Session will be saved automatically when login is detected.');

  // Launch headed browser (will steal focus, but that's fine for login)
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CHATGPT_URL);

  // Wait for login by detecting logged-in state
  // ChatGPT shows the composer even before login, so we check for:
  // 1. ABSENCE of login/signup buttons (present when logged out)
  // 2. PRESENCE of user menu button (only appears when logged in)
  console.log('[ask-question-login] Waiting for login...');
  console.log('[ask-question-login] (Log in, then wait for "Login detected!" message)');

  // Selectors for logged-out state (these should NOT be visible when logged in)
  const loginButtonSelectors = [
    'button:has-text("Log in")',
    'button:has-text("Sign up")',
    'a:has-text("Log in")',
    'a:has-text("Sign up")',
    '[data-testid="login-button"]',
    '[data-testid="signup-button"]'
  ].join(', ');

  // Selectors for logged-in state (user menu/avatar in nav)
  const userMenuSelectors = [
    '[data-testid="profile-button"]',
    'button[aria-label*="profile" i]',
    'button[aria-label*="account" i]',
    'nav button:has(img[alt])',  // Avatar image in nav button
    'header button:has(img[alt])'
  ].join(', ');

  // Poll until we detect logged-in state
  const startTime = Date.now();
  const maxWait = 300000; // 5 minutes

  while (Date.now() - startTime < maxWait) {
    const url = page.url();

    // Skip if we're on an auth page
    if (url.includes('/auth') || url.includes('login.') || url.includes('auth0')) {
      await page.waitForTimeout(1000);
      continue;
    }

    // Check for logged-in indicators
    const loginButtonVisible = await page.locator(loginButtonSelectors).first()
      .isVisible({ timeout: 500 }).catch(() => false);

    const userMenuVisible = await page.locator(userMenuSelectors).first()
      .isVisible({ timeout: 500 }).catch(() => false);

    // Logged in if user menu is visible (definitive)
    if (userMenuVisible) {
      console.log('[ask-question-login] Login detected! (user menu visible)');
      break;
    }

    // Or if no login buttons visible for sustained period (fallback)
    if (!loginButtonVisible) {
      // Wait and recheck to ensure it's not just page loading
      await page.waitForTimeout(3000);

      const stillNoLoginButton = await page.locator(loginButtonSelectors).first()
        .isVisible({ timeout: 500 }).catch(() => false);

      if (!stillNoLoginButton) {
        // No login buttons for 3+ seconds - likely logged in
        console.log('[ask-question-login] Login detected! (no login buttons)');
        break;
      }
    }

    await page.waitForTimeout(1000);
  }

  if (Date.now() - startTime >= maxWait) {
    console.error('[ask-question-login] Timeout waiting for login. Please try again.');
    await browser.close();
    process.exit(1);
  }

  // Extra delay to ensure cookies are fully set
  await page.waitForTimeout(2000);

  // Save storage state
  await context.storageState({ path: STORAGE_STATE_FILE });
  console.log(`[ask-question-login] Session saved to: ${STORAGE_STATE_FILE}`);

  await browser.close();
  console.log('[ask-question-login] Done! You can now run ask-question-server (it will start headless).');
}

main().catch((e) => {
  console.error('[ask-question-login] Error:', e.message);
  process.exit(1);
});
