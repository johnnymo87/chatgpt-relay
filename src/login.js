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

  // Support Nix-provided Chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  if (executablePath) {
    console.log(`[ask-question-login] Using Chromium: ${executablePath}`);
  }

  // Launch headed browser (will steal focus, but that's fine for login)
  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CHATGPT_URL);

  // Wait for login by polling for the login button to disappear.
  // ChatGPT shows "Log in" / "Sign in" buttons when not authenticated.
  // We wait until those are gone and a logged-in indicator appears.
  console.log('[ask-question-login] Waiting for login...');
  console.log('[ask-question-login] (Log in, then wait for "Login detected!" message)');

  const loginButtonSelector = [
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'a[href*="/auth"]'
  ].join(', ');

  const loggedInIndicatorSelector = [
    'nav[aria-label="Chat history"]',
    '#prompt-textarea',
    'img[alt="User"]'
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

    // If login button is visible, user hasn't logged in yet
    const loginBtnVisible = await page.locator(loginButtonSelector).first()
      .isVisible({ timeout: 500 }).catch(() => false);

    if (loginBtnVisible) {
      await page.waitForTimeout(1000);
      continue;
    }

    // Login button gone -- verify with a positive indicator
    const indicatorVisible = await page.locator(loggedInIndicatorSelector).first()
      .isVisible({ timeout: 500 }).catch(() => false);

    if (indicatorVisible) {
      console.log('[ask-question-login] Login detected! (login button gone, logged-in indicator visible)');
      break;
    }

    await page.waitForTimeout(1000);
  }

  if (Date.now() - startTime >= maxWait) {
    console.error('[ask-question-login] Timeout: Login not detected within 5 minutes.');
    console.error('[ask-question-login] Please try again.');
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
