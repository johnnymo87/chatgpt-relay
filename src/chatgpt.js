/**
 * ChatGPT DOM automation helpers.
 * Uses Playwright Locators (not ElementHandles) to avoid stale element issues.
 */

const CHATGPT_URL = 'https://chatgpt.com';

// Selectors - grouped for easy maintenance when ChatGPT UI changes
// Note: contenteditable is prioritized because ChatGPT uses a hidden fallback textarea
const SELECTORS = {
  composer: [
    'div[contenteditable="true"][data-placeholder]',
    '#prompt-textarea:not([class*="fallback"])',
    'textarea[data-id="root"]',
    'textarea[placeholder*="Message"]'
  ].join(', '),

  sendButton: [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]'
  ].join(', '),

  stopButton: '[data-testid="stop-button"], button[aria-label*="Stop"]',

  assistantMessage: '[data-message-author-role="assistant"]',

  // Error state selectors
  errorToast: [
    '[data-testid="error-toast"]',
    '[role="alert"]',
    '.toast-error',
    'div:has-text("Something went wrong")'
  ].join(', '),

  continueButton: [
    'button:has-text("Continue generating")',
    'button:has-text("Continue")',
    '[data-testid="continue-button"]'
  ].join(', '),

  loginButton: [
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'a[href*="/auth"]'
  ].join(', ')
};

/**
 * Find or create a ChatGPT page in the browser context.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>}
 */
export async function getOrCreateChatGPTPage(context) {
  // Look for existing ChatGPT tab
  for (const page of context.pages()) {
    if (page.url().startsWith(CHATGPT_URL)) {
      return page;
    }
  }

  // No existing tab, create one
  const page = await context.newPage();
  await page.goto(CHATGPT_URL);
  return page;
}

/**
 * Navigate to a fresh chat.
 * @param {import('playwright').Page} page
 */
export async function navigateToNewChat(page) {
  const url = page.url();
  if (url !== CHATGPT_URL && url !== `${CHATGPT_URL}/`) {
    await page.goto(CHATGPT_URL);
    await page.waitForLoadState('domcontentloaded');
  }
}

/**
 * Send a prompt and wait for the response.
 * @param {import('playwright').Page} page
 * @param {string} prompt
 * @param {object} opts
 * @param {number} opts.timeout - Max wait time in ms (default: 600000)
 * @returns {Promise<string>} The assistant's response text
 */
export async function sendPromptAndWait(page, prompt, opts = {}) {
  const timeout = opts.timeout ?? 600000;

  // Use Locator which re-resolves on each action (no stale element issues)
  const composer = page.locator(SELECTORS.composer).first();

  // Wait for composer to be visible
  await composer.waitFor({ state: 'visible', timeout: 15000 });

  // Fill works on textarea, input, AND contenteditable
  await composer.fill(prompt);

  // Count assistant messages BEFORE sending to track our response
  const assistantMsgs = page.locator(SELECTORS.assistantMessage);
  const beforeCount = await assistantMsgs.count();

  // Wait for send button to be enabled, then click
  const sendBtn = page.locator(SELECTORS.sendButton).first();

  try {
    // Wait for button to be clickable
    await page.waitForFunction(
      (sel) => {
        const btn = document.querySelector(sel);
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      },
      SELECTORS.sendButton.split(', ')[0], // Use first selector for check
      { timeout: 5000 }
    ).catch(() => {});

    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click({ timeout: 3000 });
    } else {
      await composer.press('Enter');
    }
  } catch {
    // Fallback: press Enter
    await composer.press('Enter');
  }

  // Wait for response to complete
  const response = await waitForResponse(page, beforeCount, timeout);
  return response;
}

/**
 * Wait for the assistant's response to complete.
 * Uses stop button lifecycle: visible (generating) -> hidden (done)
 * This is more reliable than counting DOM nodes for React SPAs.
 * @param {import('playwright').Page} page
 * @param {number} beforeCount - Number of assistant messages before sending
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<string>}
 */
async function waitForResponse(page, beforeCount, timeout) {
  const stopBtn = page.locator(SELECTORS.stopButton);

  // Step 1: Wait for stop button to APPEAR (generation started)
  console.log('[chatgpt] Waiting for generation to start...');
  try {
    await stopBtn.waitFor({ state: 'visible', timeout: 30000 });
    console.log('[chatgpt] Generation started (stop button visible)');
  } catch {
    // Stop button might not appear for very fast responses, continue anyway
    console.log('[chatgpt] Stop button not seen, continuing...');
  }

  // Step 2: Wait for stop button to DISAPPEAR (generation ended)
  console.log('[chatgpt] Waiting for generation to complete...');
  await stopBtn.waitFor({ state: 'hidden', timeout }).catch(() => {
    console.log('[chatgpt] Stop button wait timed out');
  });
  console.log('[chatgpt] Generation complete');

  // Step 3: Get the last assistant message
  const lastAssistant = page.locator(SELECTORS.assistantMessage).last();

  // Wait for it to be visible
  try {
    await lastAssistant.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error('No assistant message found after generation completed');
  }

  // Step 4: Wait for text to stabilize (stops changing for ~1.5s)
  console.log('[chatgpt] Waiting for response to stabilize...');
  const startTime = Date.now();
  let lastText = '';
  let stableMs = 0;
  const stabilityThreshold = 1500; // 1.5 seconds of no changes

  while (Date.now() - startTime < timeout) {
    // Check for error states
    await checkErrorStates(page);

    // Check for "Continue generating" button and click if present
    const continueBtn = page.locator(SELECTORS.continueButton).first();
    if (await continueBtn.isVisible({ timeout: 100 }).catch(() => false)) {
      console.log('[chatgpt] Clicking "Continue generating"...');
      await continueBtn.click().catch(() => {});
      stableMs = 0;
      await page.waitForTimeout(500);
      continue;
    }

    const currentText = (await lastAssistant.innerText().catch(() => '')).trim();

    if (currentText && currentText === lastText) {
      stableMs += 250;
      if (stableMs >= stabilityThreshold) {
        console.log(`[chatgpt] Response stabilized (${currentText.length} chars)`);
        return currentText;
      }
    } else {
      stableMs = 0;
      lastText = currentText;
    }

    await page.waitForTimeout(250);
  }

  // Timeout - return whatever we have
  const finalText = (await lastAssistant.innerText().catch(() => '')).trim();
  if (finalText) {
    console.log(`[chatgpt] Timeout but have partial response (${finalText.length} chars)`);
    return finalText;
  }

  throw new Error('Timeout waiting for ChatGPT response');
}

/**
 * Check for error states and throw descriptive errors.
 * @param {import('playwright').Page} page
 */
async function checkErrorStates(page) {
  // Check for logged out state (URL redirect to auth)
  const url = page.url();
  if (url.includes('/auth') || url.includes('login.openai.com')) {
    throw new Error('Session expired. Run cgpt-login to log in again.');
  }

  // Check for login button on page
  const loginBtn = page.locator(SELECTORS.loginButton).first();
  if (await loginBtn.isVisible({ timeout: 100 }).catch(() => false)) {
    throw new Error('Session expired. Run cgpt-login to log in again.');
  }

  // Check for error toast
  const errorToast = page.locator(SELECTORS.errorToast).first();
  if (await errorToast.isVisible({ timeout: 100 }).catch(() => false)) {
    const errorText = await errorToast.innerText().catch(() => 'Unknown error');
    throw new Error(`ChatGPT error: ${errorText.trim()}`);
  }
}
