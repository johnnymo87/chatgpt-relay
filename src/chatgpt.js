/**
 * ChatGPT DOM automation helpers.
 * Uses Playwright Locators (not ElementHandles) to avoid stale element issues.
 */

const CHATGPT_URL = 'https://chatgpt.com';

/**
 * Check if a response is a ChatGPT streaming/conversation response.
 * @param {import('playwright').Response} resp
 * @returns {boolean}
 */
function isChatGPTStreamResponse(resp) {
  const url = resp.url();
  const req = resp.request();
  return (
    req.method() === 'POST' &&
    (url.includes('/backend-api/conversation') ||
     url.includes('/backend-anon/conversation') ||
     url.includes('/backend-api/sentinel/chat-requirements'))
  );
}

/**
 * Convert Chromium network error codes to friendly messages.
 * @param {string|undefined} errorText - e.g., 'net::ERR_INTERNET_DISCONNECTED'
 * @returns {string}
 */
function friendlyNetError(errorText) {
  const t = String(errorText || '');
  if (t.includes('ERR_INTERNET_DISCONNECTED')) return 'Network disconnected';
  if (t.includes('ERR_NETWORK_CHANGED')) return 'Network changed (interface switch / reconnect)';
  if (t.includes('ERR_NAME_NOT_RESOLVED')) return 'DNS failure (no internet or DNS misconfigured)';
  if (t.includes('ERR_CONNECTION_TIMED_OUT')) return 'Network timeout';
  if (t.includes('ERR_CONNECTION_REFUSED')) return 'Connection refused';
  if (t.includes('ERR_CONNECTION_RESET')) return 'Connection reset';
  return `Network error: ${t || 'unknown'}`;
}

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

  copyTurnButton: '[data-testid="copy-turn-action-button"]',

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
 * @param {number} opts.timeout - Max wait time in ms (default: 1200000)
 * @returns {Promise<string>} The assistant's response text
 */
export async function sendPromptAndWait(page, prompt, opts = {}) {
  const timeout = opts.timeout ?? 1200000;

  // Check login state before attempting to fill composer
  await assertLoggedIn(page);

  // Use Locator which re-resolves on each action (no stale element issues)
  const composer = page.locator(SELECTORS.composer).first();

  // Wait for composer to be visible
  await composer.waitFor({ state: 'visible', timeout: 15000 });

  // Fill works on textarea, input, AND contenteditable
  await composer.fill(prompt);

  // Count assistant messages BEFORE sending to track our response
  const assistantMsgs = page.locator(SELECTORS.assistantMessage);
  const beforeCount = await assistantMsgs.count();

  // Start listening for the streaming response BEFORE clicking send
  // This ensures we don't miss it due to race conditions
  const streamResponsePromise = page.waitForResponse(isChatGPTStreamResponse, { timeout: 30000 })
    .catch(() => null); // Don't fail if no matching response (fallback to DOM-only)

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

  // Wait for response to complete, with network failure detection
  const response = await waitForResponse(page, beforeCount, timeout, streamResponsePromise);
  return response;
}

/**
 * Safely read clipboard text, returning empty string on failure.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readClipboardText(page) {
  return await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  });
}

/**
 * Extract response text via copy button (preferred) or innerText (fallback).
 * Copy button preserves markdown formatting.
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} messageLocator - The assistant message locator
 * @returns {Promise<string>}
 */
async function extractResponseText(page, messageLocator) {
  // Try clipboard extraction (best effort)
  try {
    // Navigate up to the turn container (article) that holds both message and action buttons
    // ChatGPT DOM: article[data-testid] > div > div[data-message-author-role] (message)
    //                                       > div (action bar with copy button)
    const turnContainer = messageLocator.locator('xpath=ancestor::article[@data-testid]');

    // Check if turn container was found (DOM structure may have changed)
    if (await turnContainer.count() === 0) {
      console.log('[chatgpt] Turn container not found (DOM may have changed), using innerText');
      const text = await messageLocator.innerText();
      return text.trim();
    }

    const copyBtn = turnContainer.locator(SELECTORS.copyTurnButton);

    // Hover the turn container to reveal action buttons (they have pointer-events:none until hover)
    await turnContainer.hover({ timeout: 2000 }).catch(() => {});

    // Use waitFor, not isVisible(timeout) - timeout is ignored in isVisible
    await copyBtn.waitFor({ state: 'visible', timeout: 1500 });

    // Ensure document focus (helps with Clipboard API in some cases)
    await page.click('body', { position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});

    // Snapshot clipboard before click
    const before = await readClipboardText(page);

    // Use force:true to bypass pointer-events:none overlay on action bar
    await copyBtn.click({ timeout: 1500, force: true });

    // Poll until clipboard changes (more robust than fixed wait)
    const handle = await page.waitForFunction(
      async (prev) => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text || !text.trim()) return null;
          if (prev && text === prev) return null;
          return text;
        } catch {
          return null;
        }
      },
      before,
      { timeout: 2000 }
    );

    const copied = await handle.jsonValue();
    if (copied && copied.trim()) {
      console.log(`[chatgpt] Extracted via copy button (${copied.length} chars)`);
      return copied.trim();
    }
  } catch (e) {
    console.log(`[chatgpt] Copy button extraction failed: ${e.message}, falling back to innerText`);
  }

  // Fallback to innerText
  const text = await messageLocator.innerText();
  console.log(`[chatgpt] Extracted via innerText (${text.length} chars)`);
  return text.trim();
}

/**
 * Wait for the assistant's response to complete.
 * Uses stop button lifecycle: visible (generating) -> hidden (done)
 * This is more reliable than counting DOM nodes for React SPAs.
 * @param {import('playwright').Page} page
 * @param {number} beforeCount - Number of assistant messages before sending
 * @param {number} timeout - Max wait time in ms
 * @param {Promise<import('playwright').Response|null>} streamResponsePromise - Promise for the streaming response
 * @returns {Promise<string>}
 */
async function waitForResponse(page, beforeCount, timeout, streamResponsePromise) {
  const stopBtn = page.locator(SELECTORS.stopButton);

  // Get the stream response (may be null if not captured)
  const streamResponse = await streamResponsePromise;
  let networkErrorPromise = null;

  if (streamResponse) {
    console.log('[chatgpt] Tracking stream response for network failures');
    // response.finished() returns null on success, Error on failure
    networkErrorPromise = streamResponse.finished().then((maybeErr) => {
      if (maybeErr instanceof Error) {
        throw new Error(`Network failure: ${friendlyNetError(maybeErr.message)}`);
      }
      // Success - return a sentinel that won't affect the race
      return { __networkOk: true };
    });
  }

  // Step 1: Wait for stop button to APPEAR (generation started)
  console.log('[chatgpt] Waiting for generation to start...');
  try {
    const startWait = stopBtn.waitFor({ state: 'visible', timeout: 30000 });
    if (networkErrorPromise) {
      // Race against network errors
      const result = await Promise.race([startWait, networkErrorPromise]);
      if (result?.__networkOk) {
        // Network finished before stop button - wait for stop button anyway
        await startWait.catch(() => {});
      }
    } else {
      await startWait;
    }
    console.log('[chatgpt] Generation started (stop button visible)');
  } catch (e) {
    if (e.message.includes('Network failure')) throw e;
    // Stop button might not appear for very fast responses, continue anyway
    console.log('[chatgpt] Stop button not seen, continuing...');
  }

  // Step 2: Wait for stop button to DISAPPEAR (generation ended)
  console.log('[chatgpt] Waiting for generation to complete...');
  try {
    const completeWait = stopBtn.waitFor({ state: 'hidden', timeout });
    if (networkErrorPromise) {
      const result = await Promise.race([completeWait, networkErrorPromise]);
      if (result?.__networkOk) {
        await completeWait.catch(() => {});
      }
    } else {
      await completeWait;
    }
  } catch (e) {
    if (e.message.includes('Network failure')) throw e;
    console.log('[chatgpt] Stop button wait timed out');
  }
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

    const currentText = (await lastAssistant.innerText().catch((e) => {
      console.log(`[chatgpt] innerText error: ${e.message}`);
      return '';
    })).trim();
    if (!currentText && stableMs === 0) {
      // Log once when we first see empty text (usually transient during generation)
      const count = await page.locator(SELECTORS.assistantMessage).count();
      console.log(`[chatgpt] Empty text, assistant message count: ${count}`);
    }

    if (currentText && currentText === lastText) {
      stableMs += 250;
      if (stableMs >= stabilityThreshold) {
        console.log(`[chatgpt] Response stabilized (${currentText.length} chars)`);
        return await extractResponseText(page, lastAssistant);
      }
    } else {
      stableMs = 0;
      lastText = currentText;
    }

    await page.waitForTimeout(250);
  }

  // Timeout - return whatever we have
  const finalText = await extractResponseText(page, lastAssistant).catch(() => '');
  if (finalText) {
    console.log(`[chatgpt] Timeout but have partial response (${finalText.length} chars)`);
    return finalText;
  }

  throw new Error('Timeout waiting for ChatGPT response');
}

/**
 * Check if the user is logged in to ChatGPT.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isLoggedIn(page) {
  // Check for logged out state (URL redirect to auth)
  const url = page.url();
  if (url.includes('/auth') || url.includes('login.openai.com')) {
    return false;
  }

  // Check for login button on page
  const loginBtn = page.locator(SELECTORS.loginButton).first();
  if (await loginBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    return false;
  }

  return true;
}

/**
 * Assert that the user is logged in, throwing a clear error if not.
 * @param {import('playwright').Page} page
 */
export async function assertLoggedIn(page) {
  if (!(await isLoggedIn(page))) {
    throw new Error('Not logged in to ChatGPT. Run "ask-question-login" first.');
  }
}

/**
 * Check for error states and throw descriptive errors.
 * @param {import('playwright').Page} page
 */
async function checkErrorStates(page) {
  // Check for logged out state
  await assertLoggedIn(page);

  // Check for error toast
  const errorToast = page.locator(SELECTORS.errorToast).first();
  if (await errorToast.isVisible({ timeout: 100 }).catch(() => false)) {
    const errorText = await errorToast.innerText().catch(() => 'Unknown error');
    throw new Error(`ChatGPT error: ${errorText.trim()}`);
  }
}
