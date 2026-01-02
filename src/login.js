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

  // Wait for login by detecting the chat history panel (left sidebar)
  // This only appears when logged in, making it a reliable indicator
  console.log('[ask-question-login] Waiting for login...');
  console.log('[ask-question-login] (Log in, then wait for "Login detected!" message)');

  // Selector for chat history panel (only visible when logged in)
  const chatHistorySelector = 'nav[aria-label="Chat history"]';

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

    // Check for chat history panel (only visible when logged in)
    const chatHistoryVisible = await page.locator(chatHistorySelector)
      .isVisible({ timeout: 500 }).catch(() => false);

    if (chatHistoryVisible) {
      console.log('[ask-question-login] Login detected! (chat history panel visible)');
      break;
    }

    await page.waitForTimeout(1000);
  }

  if (Date.now() - startTime >= maxWait) {
    console.error('[ask-question-login] Timeout: Chat history panel not found.');
    console.error('[ask-question-login] Login may have failed. Please try again.');
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
