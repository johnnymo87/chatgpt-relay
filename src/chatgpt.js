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
 * @param {number} opts.timeout - Max wait time in ms (default: 120000)
 * @returns {Promise<string>} The assistant's response text
 */
export async function sendPromptAndWait(page, prompt, opts = {}) {
  const timeout = opts.timeout ?? 120000;

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
 * Tracks message count to ensure we get the response to THIS prompt.
 * @param {import('playwright').Page} page
 * @param {number} beforeCount - Number of assistant messages before sending
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<string>}
 */
async function waitForResponse(page, beforeCount, timeout) {
  const assistantMsgs = page.locator(SELECTORS.assistantMessage);
  const stopBtn = page.locator(SELECTORS.stopButton);

  // Wait for a NEW assistant message to appear
  try {
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length > n,
      { sel: SELECTORS.assistantMessage, n: beforeCount },
      { timeout: Math.min(timeout, 30000) }
    );
  } catch {
    throw new Error('No response received from ChatGPT. Are you logged in?');
  }

  // Get the new message (first one after beforeCount)
  const newMsg = assistantMsgs.nth(beforeCount);

  // Wait for it to have some content
  await page.waitForFunction(
    (sel, idx) => {
      const msgs = document.querySelectorAll(sel);
      const msg = msgs[idx];
      return msg && msg.innerText && msg.innerText.trim().length > 0;
    },
    [SELECTORS.assistantMessage, beforeCount],
    { timeout: Math.min(timeout, 30000) }
  ).catch(() => {});

  // Wait for generation to stop (stop button disappears)
  await stopBtn.waitFor({ state: 'detached', timeout }).catch(() => {});

  // Wait for text stability (stops changing for ~1s)
  const startTime = Date.now();
  let lastText = '';
  let stableCount = 0;

  while (Date.now() - startTime < timeout) {
    // Check for error states before checking response
    await checkErrorStates(page);

    // Check for "Continue generating" button and click if present
    const continueBtn = page.locator(SELECTORS.continueButton).first();
    if (await continueBtn.isVisible({ timeout: 100 }).catch(() => false)) {
      await continueBtn.click().catch(() => {});
      stableCount = 0; // Reset stability counter
      await page.waitForTimeout(500);
      continue;
    }

    // Use innerText (what user sees) not textContent
    const currentText = await newMsg.innerText().catch(() => '');
    const trimmed = currentText?.trim() ?? '';

    if (trimmed && trimmed === lastText) {
      stableCount++;
      if (stableCount >= 2) {
        // Stable for ~1s (2 cycles at 500ms)
        return trimmed;
      }
    } else {
      stableCount = 0;
      lastText = trimmed;
    }

    await page.waitForTimeout(500);
  }

  // Timeout - return whatever we have
  const finalText = await newMsg.innerText().catch(() => '');
  if (finalText?.trim()) {
    return finalText.trim();
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
