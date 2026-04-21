/**
 * ChatGPT DOM automation helpers.
 * Uses Playwright Locators (not ElementHandles) to avoid stale element issues.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CHATGPT_URL = 'https://chatgpt.com';
const DEBUG_DIR = path.join(os.homedir(), '.chatgpt-relay', 'debug');

/**
 * Check if a button exists in the DOM and has non-zero dimensions.
 * This bypasses Playwright's visibility algorithm which can miss buttons
 * during Extended Thinking (overlay, opacity, or CSS differences).
 * @param {import('playwright').Page} page
 * @param {string} selector - CSS selector for the button
 * @returns {Promise<boolean>}
 */
async function isButtonInDOM(page, selector) {
  return await page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return false;
    const rect = btn.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0;
  }, selector).catch(() => false);
}

/**
 * Save a debug screenshot. Best-effort, never throws.
 * @param {import('playwright').Page} page
 * @param {string} label - Short label for the screenshot filename
 */
async function debugScreenshot(page, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(DEBUG_DIR, `${ts}-${label}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`[chatgpt] Debug screenshot saved: ${filePath}`);
  } catch (e) {
    console.log(`[chatgpt] Debug screenshot failed: ${e.message}`);
  }
}

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

/**
 * Create a network guard that rejects when critical network requests fail.
 * Race this against DOM waits to detect network disconnections quickly
 * instead of waiting for a 10+ minute timeout.
 *
 * @param {import('playwright').Page} page
 * @returns {{ promise: Promise<void>, dispose: () => void }}
 */
function createNetworkGuard(page) {
  let rejectFn;
  let onRequestFailed;
  let onCrash;
  let onClose;

  const promise = new Promise((_, reject) => {
    rejectFn = reject;

    onRequestFailed = (request) => {
      const url = request.url();
      // Only watch chat-related endpoints (not images, analytics, etc.)
      const isChatEndpoint =
        url.includes('/backend-api/') ||
        url.includes('/backend-anon/') ||
        url.includes('/conversation');
      if (!isChatEndpoint) return;

      const failure = request.failure();
      const errorText = failure?.errorText || '';

      // Only reject on connectivity errors, not transient 4xx/5xx
      const isFatal =
        errorText.includes('ERR_INTERNET_DISCONNECTED') ||
        errorText.includes('ERR_NETWORK_CHANGED') ||
        errorText.includes('ERR_NAME_NOT_RESOLVED') ||
        errorText.includes('ERR_CONNECTION_TIMED_OUT') ||
        errorText.includes('ERR_CONNECTION_REFUSED') ||
        errorText.includes('ERR_CONNECTION_RESET') ||
        errorText.includes('net::ERR_FAILED');
      if (!isFatal) return;

      reject(new Error(`Network failure: ${friendlyNetError(errorText)}`));
    };

    onCrash = () => reject(new Error('Browser tab crashed'));
    onClose = () => reject(new Error('Page closed unexpectedly'));

    page.on('requestfailed', onRequestFailed);
    page.on('crash', onCrash);
    page.on('close', onClose);
  });

  // Prevent unhandled rejection if guard is never raced against
  promise.catch(() => {});

  const dispose = () => {
    page.off('requestfailed', onRequestFailed);
    page.off('crash', onCrash);
    page.off('close', onClose);
  };

  return { promise, dispose };
}

// Selectors - grouped for easy maintenance when ChatGPT UI changes
// Note: contenteditable is prioritized because ChatGPT uses a hidden fallback textarea.
// Last verified: March 2026. ChatGPT uses a ProseMirror contenteditable div.
const COMPOSER_SELECTORS = [
  'div#prompt-textarea[contenteditable="true"]',
  '#prompt-textarea:not([class*="fallback"])',
  '[role="textbox"][contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
];

const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'form button[type="submit"]'
];

const SELECTORS = {
  composer: COMPOSER_SELECTORS.join(', '),

  sendButton: SEND_BUTTON_SELECTORS.join(', '),

  stopButton: '[data-testid="stop-button"], button[aria-label*="Stop"]',

  assistantMessage: '[data-message-author-role="assistant"]',

  // Turn container selector (March 2026: changed from article to section)
  assistantTurn: 'section[data-turn="assistant"]',

  // Error state selectors
  // Note: [role="alert"] was intentionally removed -- it's too broad and
  // matches ARIA live regions (e.g., screen-reader announcements) that
  // are not actual error toasts, causing false-positive failures.
  // Note: bare 'div:has-text("Something went wrong")' was removed because
  // it matches the entire page body (any ancestor div containing the text),
  // producing error messages that include the full page innerText.
  errorToast: [
    '[data-testid="error-toast"]',
    '.toast-error',
  ].join(', '),

  continueButton: [
    'button:has-text("Continue generating")',
    'button:has-text("Continue")',
    '[data-testid="continue-button"]'
  ].join(', '),

  copyTurnButton: '[data-testid="copy-turn-action-button"]',

  // Selectors that identify a real ChatGPT login button in the page chrome
  // (header / OAuth dialog), NOT in assistant message content.
  //
  // IMPORTANT: a[href*="/auth"] was REMOVED here -- it false-matched
  // citation anchors in deep-research responses (e.g., GitHub Docs links
  // to /auth/* pages), causing isLoggedIn to spuriously return false
  // AFTER a successful long generation. The URL check at the top of
  // isLoggedIn already detects redirects to /auth pages, so a header-link
  // selector is redundant.
  //
  // Button text selectors are kept narrow (literal "Log in" / "Sign in")
  // because ChatGPT renders citation/quote links as <a>, not <button>, so
  // a real assistant response containing those phrases as plain text in a
  // citation will not match a <button>.
  loginButton: [
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
  ].join(', '),

  // Positive indicators that the user is logged in.
  // At least one must be visible to confirm login state.
  // Note: img[alt="User"] removed March 2026 -- no longer present in ChatGPT UI.
  loggedInIndicator: [
    'nav[aria-label="Chat history"]',
    '#prompt-textarea'
  ].join(', ')
};

/**
 * Find the first visible locator from a selector list.
 * Logs the matched selector for easier UI drift debugging.
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {string} targetName
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function firstVisibleLocator(page, selectors, targetName) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log(`[chatgpt] Using ${targetName} selector: ${selector}`);
      return locator;
    }
  }
  return null;
}

/**
 * Resolve the composer locator with resilient selector fallbacks.
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').Locator>}
 */
async function resolveComposer(page) {
  const matchedComposer = await firstVisibleLocator(page, COMPOSER_SELECTORS, 'composer');
  if (matchedComposer) return matchedComposer;

  // Broad fallback: scope to visible contenteditable elements inside <main>.
  // Excludes bare 'textarea' which can match the hidden ProseMirror fallback textarea.
  const broadFallback = page.locator('main [role="textbox"], main [contenteditable="true"]').first();
  if (await broadFallback.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('[chatgpt] Using broad composer fallback selector inside <main>');
    return broadFallback;
  }

  throw new Error(
    `Could not find ChatGPT composer. UI may have changed. Tried selectors: ${COMPOSER_SELECTORS.join(' | ')}`
  );
}

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
 * Waits for the composer to be ready after navigation.
 * @param {import('playwright').Page} page
 */
export async function navigateToNewChat(page) {
  const url = page.url();
  if (url !== CHATGPT_URL && url !== `${CHATGPT_URL}/`) {
    await page.goto(CHATGPT_URL);
    await page.waitForLoadState('domcontentloaded');
  }

  // Wait for the composer to be interactive after navigation.
  // ChatGPT's SPA re-renders the composer after route changes, which can
  // take several seconds. Without this wait, resolveComposer() may fail.
  try {
    await page.locator('div#prompt-textarea[contenteditable="true"]')
      .first().waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    // If composer doesn't appear, resolveComposer will handle with fallbacks
    console.log('[chatgpt] Composer not visible after navigation, will try fallbacks');
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

  // Pre-flight checks: verify page is ready for input
  await assertReadyForInput(page);

  // Use Locator which re-resolves on each action (no stale element issues)
  const composer = await resolveComposer(page);

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
      SEND_BUTTON_SELECTORS[0], // Use first selector for check
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
 * Extract response text via the copy button on the turn container.
 * This is the most reliable method as it preserves markdown formatting
 * and works even when innerText returns empty (e.g., thinking model responses).
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} messageLocator - The assistant message locator
 * @returns {Promise<string>}
 */
async function extractViaCopyButton(page, messageLocator) {
  // Navigate up to the turn container (section) that holds both message and action buttons
  // ChatGPT DOM (March 2026): section[data-testid][data-turn] > ... > div[data-message-author-role] (message)
  //                                                           > div (action bar with copy button)
  // Note: previously used <article>, OpenAI changed to <section> circa early 2026.
  const turnContainer = messageLocator.locator('xpath=ancestor::section[@data-testid]');

  // Check if turn container was found (DOM structure may have changed)
  if (await turnContainer.count() === 0) {
    throw new Error('Turn container not found');
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

  throw new Error('Copy button clicked but clipboard empty');
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
    const text = await extractViaCopyButton(page, messageLocator);
    return text;
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

  // Network guard: detects connectivity failures via requestfailed events.
  // This catches broader failures than streamResponse.finished() alone
  // (e.g., failures in non-streaming requests, post-stream disconnects).
  const networkGuard = createNetworkGuard(page);

  try {
    return await _waitForResponseInner(page, stopBtn, beforeCount, timeout, streamResponsePromise, networkGuard);
  } finally {
    networkGuard.dispose();
  }
}

async function _waitForResponseInner(page, stopBtn, beforeCount, timeout, streamResponsePromise, networkGuard) {
  // Get the stream response (may be null if not captured)
  const streamResponse = await streamResponsePromise;
  let networkErrorPromise = networkGuard.promise;

  if (streamResponse) {
    console.log('[chatgpt] Tracking stream response for network failures');
    // response.finished() returns null on success, Error on failure.
    // Race this against the broader network guard for defense-in-depth.
    const streamFinished = streamResponse.finished().then((maybeErr) => {
      if (maybeErr instanceof Error) {
        throw new Error(`Network failure: ${friendlyNetError(maybeErr.message)}`);
      }
      // Success - return a sentinel that won't affect the race
      return { __networkOk: true };
    });
    networkErrorPromise = Promise.race([networkGuard.promise, streamFinished]);
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

  console.log('[chatgpt] Generation complete (stop button hidden)');

  // Step 3: Get the last assistant message
  const assistantMsgCount = await page.locator(SELECTORS.assistantMessage).count();
  console.log(`[chatgpt] Found ${assistantMsgCount} assistant message(s) in DOM`);
  const lastAssistant = page.locator(SELECTORS.assistantMessage).last();

  // Wait for it to be visible
  try {
    await lastAssistant.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error('No assistant message found after generation completed');
  }

  // Step 4: Wait for text to stabilize (stops changing for ~1.5s)
  // Initial hydration delay: ChatGPT's React app needs time to render
  // the response text into the DOM after the stop button disappears.
  // Without this, innerText returns empty for the first several seconds.
  console.log('[chatgpt] Waiting for DOM hydration...');
  await page.waitForTimeout(2000);

  console.log('[chatgpt] Waiting for response to stabilize...');
  const startTime = Date.now();
  let lastText = '';
  let stableMs = 0;
  let emptyTextMs = 0;
  let consecutiveEmptyIterations = 0;
  let sendBtnNotReadyMs = 0; // How long we've been waiting with stable text but no send button
  let sendBtnScreenshotTaken = false;
  // After this many consecutive all-empty iterations (~30s of 250ms polling,
  // plus the 2s hydration delay = ~32s total), give up and throw.
  // This is deliberately generous to accommodate slow rendering, extended
  // thinking responses, and the copy-button fallback attempts.
  const maxConsecutiveEmptyIterations = 120;
  const stabilityThreshold = 1500; // 1.5 seconds of no changes
  const emptyTextFallbackMs = 10000; // Try copy button after 10s of empty text
  let loggedEmptyOnce = false;
  let loggedInnerTextError = false;

  while (Date.now() - startTime < timeout) {
    // Check for error states
    await checkErrorStates(page);

    // Check if stop button is in the DOM (multi-phase generation, Extended Thinking).
    // Uses direct DOM query because Playwright's isVisible/waitFor can miss the
    // stop button during Extended Thinking (CSS overlay/opacity differences).
    if (await isButtonInDOM(page, '[data-testid="stop-button"]')) {
      // Stop button is present and has dimensions — generation in progress.
      // Don't log every iteration (250ms), just reset and keep waiting.
      stableMs = 0;
      emptyTextMs = 0;
      consecutiveEmptyIterations = 0;
      sendBtnNotReadyMs = 0;
      await page.waitForTimeout(2000);
      continue;
    }

    // Check for "Continue generating" button and click if present
    const continueBtn = page.locator(SELECTORS.continueButton).first();
    if (await continueBtn.isVisible({ timeout: 100 }).catch(() => false)) {
      console.log('[chatgpt] Clicking "Continue generating"...');
      await continueBtn.click().catch(() => {});
      stableMs = 0;
      emptyTextMs = 0;
      await page.waitForTimeout(500);
      continue;
    }

    // Try multiple extraction strategies, from most specific to broadest:
    // 1. Message element innerText (Playwright locator)
    // 2. DOM evaluate on the message element (bypasses Playwright rendering)
    // 3. Section-level text extraction (gets all text in the turn)
    let currentText = (await lastAssistant.innerText().catch(e => {
      if (!loggedInnerTextError) {
        console.warn(`[chatgpt] innerText failed: ${e.message}`);
        loggedInnerTextError = true;
      }
      return '';
    })).trim();

    if (!currentText) {
      // Fallback: use page.evaluate() to get text directly from the DOM.
      // Some Chromium versions don't populate text in the Playwright locator
      // while it IS accessible via direct DOM access.
      // Note: use querySelectorAll + last element to match Playwright's .last()
      currentText = await page.evaluate((sel) => {
        const els = document.querySelectorAll(sel);
        const el = els[els.length - 1];
        if (!el) return '';
        // Try the .markdown container's text specifically
        const markdown = el.querySelector('.markdown');
        if (markdown) {
          const text = markdown.innerText?.trim();
          if (text) return text;
        }
        return el.innerText?.trim() || '';
      }, SELECTORS.assistantMessage).catch(() => '');
    }

    if (!currentText) {
      // Fallback: get text from the last section turn container
      currentText = await page.evaluate(() => {
        const sections = document.querySelectorAll('section[data-turn="assistant"]');
        const section = sections[sections.length - 1];
        if (!section) return '';
        // Get text from the message area, skipping UI labels like "ChatGPT said:"
        const msg = section.querySelector('[data-message-author-role="assistant"]');
        if (msg) {
          const markdown = msg.querySelector('.markdown');
          if (markdown) return markdown.innerText?.trim() || '';
          return msg.innerText?.trim() || '';
        }
        return '';
      }).catch(() => '');
    }

    if (!currentText) {
      emptyTextMs += 250;
      consecutiveEmptyIterations++;
      if (!loggedEmptyOnce) {
        loggedEmptyOnce = true;
        console.log(`[chatgpt] All text extraction methods returning empty, will try copy button after ${emptyTextFallbackMs / 1000}s`);
      }

      // Circuit breaker: if ALL extraction strategies have returned empty
      // for too long after generation completed, something is fundamentally
      // wrong (stale page state, DOM structure change, rendering failure).
      // Throwing lets processRequest() close the page and reset state.
      if (consecutiveEmptyIterations >= maxConsecutiveEmptyIterations) {
        throw new Error(
          `Response text empty after ${Math.round(consecutiveEmptyIterations * 250 / 1000)}s of polling ` +
          `(${consecutiveEmptyIterations} consecutive empty iterations across all extraction strategies). ` +
          'Page may have stale state or ChatGPT DOM structure may have changed.'
        );
      }

      // After emptyTextFallbackMs of empty text, try copy button extraction.
      if (emptyTextMs >= emptyTextFallbackMs) {
        console.log('[chatgpt] Text still empty, trying copy button extraction...');
        const copyText = await extractViaCopyButton(page, lastAssistant).catch(() => '');
        if (copyText) {
          console.log(`[chatgpt] Copy button extraction succeeded (${copyText.length} chars)`);
          return copyText;
        }
        console.log('[chatgpt] Copy button extraction also failed, continuing to poll...');
        // Reset so we don't spam copy button attempts every 250ms
        emptyTextMs = emptyTextFallbackMs - 5000;
      }

      await page.waitForTimeout(250);
      continue;
    }

    // Got non-empty text, reset empty counters
    emptyTextMs = 0;
    consecutiveEmptyIterations = 0;

    if (currentText === lastText) {
      stableMs += 250;
      if (stableMs >= stabilityThreshold) {
        // Text has been stable for 1.5s. Check button state via direct DOM
        // queries (page.evaluate). Playwright's waitFor/isVisible cannot
        // detect the stop button during Extended Thinking — it's in the DOM
        // with dimensions but Playwright considers it not visible (likely
        // due to CSS overlay or opacity).
        const stopInDOM = await isButtonInDOM(page, '[data-testid="stop-button"]');

        if (stopInDOM) {
          // Stop button in DOM with dimensions — generation in progress.
          stableMs = 0;
          sendBtnNotReadyMs = 0;
          await page.waitForTimeout(2000);
          continue;
        }

        // Stop button gone. Check send button as confidence signal.
        const sendInDOM = await isButtonInDOM(page, '[data-testid="send-button"]');

        if (sendInDOM) {
          console.log(`[chatgpt] Response stabilized (${currentText.length} chars, send button in DOM)`);
          return await extractResponseText(page, lastAssistant);
        }

        // Neither button in DOM. This is unusual — might be a brief gap
        // or the send button has a different selector. Wait with fallback.
        sendBtnNotReadyMs += stabilityThreshold;

        if (!sendBtnScreenshotTaken) {
          const preview = currentText.length > 100
            ? currentText.substring(0, 100) + '...'
            : currentText;
          console.log(`[chatgpt] Text stable (${currentText.length} chars), stop button gone, send button not found. Preview: ${preview.replace(/\n/g, '\\n')}`);
          const btnDiag = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button')).slice(-10);
            return btns.map(b => ({
              testid: b.getAttribute('data-testid'),
              ariaLabel: b.getAttribute('aria-label'),
              text: b.innerText?.trim().substring(0, 50),
              dims: `${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`,
            }));
          }).catch(() => []);
          console.log(`[chatgpt] Last 10 buttons in DOM: ${JSON.stringify(btnDiag)}`);
          await debugScreenshot(page, 'no-stop-no-send');
          sendBtnScreenshotTaken = true;
        }

        // Accept after 30s with no stop button and no send button.
        // This is shorter than before because the stop button check is now
        // reliable — if it's truly gone, generation is likely done.
        const maxNoButtonWaitMs = 30000;
        if (sendBtnNotReadyMs >= maxNoButtonWaitMs) {
          console.log(`[chatgpt] No buttons found after ${Math.round(sendBtnNotReadyMs / 1000)}s — accepting response (${currentText.length} chars)`);
          return await extractResponseText(page, lastAssistant);
        }

        stableMs = 0;
        await page.waitForTimeout(2000);
        continue;
      }
    } else {
      stableMs = 0;
      sendBtnNotReadyMs = 0; // Text changed — reset the wait timer
      lastText = currentText;
    }

    await page.waitForTimeout(250);
  }

  // Timeout - try all extraction methods before giving up
  console.log('[chatgpt] Timeout reached, trying final extraction...');
  await debugScreenshot(page, 'timeout');
  const finalText = await extractResponseText(page, lastAssistant).catch(() => '');
  if (finalText) {
    console.log(`[chatgpt] Timeout but have partial response (${finalText.length} chars)`);
    return finalText;
  }

  // Last resort: try copy button
  const copyText = await extractViaCopyButton(page, lastAssistant).catch(() => '');
  if (copyText) {
    console.log(`[chatgpt] Timeout but got response via copy button (${copyText.length} chars)`);
    return copyText;
  }

  throw new Error('Timeout waiting for ChatGPT response');
}

/**
 * Check if the user is logged in to ChatGPT.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isLoggedIn(page, { timeout = 15000 } = {}) {
  // Check for logged out state (URL redirect to auth)
  const url = page.url();
  if (url.includes('/auth') || url.includes('login.openai.com')) {
    await logIsLoggedInDiagnostics(page, `auth-url:${url}`).catch(() => {});
    return false;
  }

  // Race: wait for either the login button or a logged-in indicator to appear.
  // ChatGPT is a SPA -- these elements are rendered by JS after page load,
  // so we need to give the page time to settle rather than doing a quick
  // snapshot check.
  const loginBtn = page.locator(SELECTORS.loginButton).first();
  const indicator = page.locator(SELECTORS.loggedInIndicator).first();

  const LOGIN_BTN = 'loginButton';
  const INDICATOR = 'loggedInIndicator';

  try {
    const winner = await Promise.race([
      loginBtn.waitFor({ state: 'visible', timeout }).then(() => LOGIN_BTN),
      indicator.waitFor({ state: 'visible', timeout }).then(() => INDICATOR)
    ]);

    if (winner === LOGIN_BTN) {
      await logIsLoggedInDiagnostics(page, 'login-button-won').catch(() => {});
      return false;
    }

    // Indicator appeared first, but double-check login button isn't also
    // visible (e.g., transient UI state).
    if (await loginBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await logIsLoggedInDiagnostics(page, 'login-button-also-visible').catch(() => {});
      return false;
    }

    return true;
  } catch {
    // Neither appeared within timeout -- ambiguous state.
    // Diagnostic: log DOM-level state of the indicator selectors so we can
    // tell whether Playwright's visibility check is missing them (same bug
    // class as the stop-button issue fixed in commit 41990f3).
    await logIsLoggedInDiagnostics(page, 'waitFor-timeout').catch(() => {});
    return false;
  }
}

/**
 * Log diagnostic info when isLoggedIn returns false from the timeout branch.
 * Best-effort, never throws. Captures Playwright vs. raw-DOM visibility for
 * the logged-in indicator selectors.
 * @param {import('playwright').Page} page
 * @param {string} reason
 */
async function logIsLoggedInDiagnostics(page, reason) {
  const allSelectors = [
    // logged-in indicators
    'nav[aria-label="Chat history"]',
    '#prompt-textarea',
    // login-button candidates (the SELECTORS.loginButton compound)
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'a[href*="/auth"]',
  ];
  const url = page.url();
  console.log(`[chatgpt] isLoggedIn=false (${reason}) url=${url}`);
  for (const sel of allSelectors) {
    const playwrightVisible = await page.locator(sel).first()
      .isVisible({ timeout: 100 }).catch(() => false);
    const domState = await page.evaluate((s) => {
      // CSS :has-text() is Playwright-only; for raw-DOM fallback, only
      // straight CSS selectors will be queried successfully.
      let el;
      try { el = document.querySelector(s); } catch { return { invalidCss: true }; }
      if (!el) return { present: false };
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        present: true,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        text: (el.innerText || el.textContent || '').slice(0, 60),
      };
    }, sel).catch((e) => ({ error: e.message }));
    console.log(`[chatgpt]   ${sel}: playwrightVisible=${playwrightVisible} dom=${JSON.stringify(domState)}`);
  }
  await debugScreenshot(page, `isLoggedIn-false-${reason}`).catch(() => {});
}

/**
 * Pre-flight check: verify the page is in a valid state to accept input.
 * Checks login state, waits for the composer, and dismisses known blockers.
 * Fails fast with a clear error instead of a 30s fill timeout.
 * @param {import('playwright').Page} page
 */
async function assertReadyForInput(page) {
  // Check login state
  await assertLoggedIn(page);

  // Wait for the composer to be visible (SPA may still be hydrating)
  const composer = page.locator(COMPOSER_SELECTORS[0]).first();
  try {
    await composer.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    throw new Error(
      'Composer not visible after 10s. Page may be blocked by a modal, ' +
      'rate limit, or ChatGPT UI change.'
    );
  }

  // Dismiss known blocking modals (best-effort, don't fail if not found).
  // These are common ChatGPT popups that block the composer.
  const dismissible = [
    // Generic modal/dialog close buttons
    '[data-testid="modal"] button[aria-label="Close"]',
    'dialog button[aria-label="Close"]',
    // "Upgrade to Plus" dismiss
    'button[aria-label="Dismiss"]',
  ];
  for (const sel of dismissible) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
      console.log(`[chatgpt] Dismissing modal: ${sel}`);
      await btn.click({ timeout: 1000 }).catch(() => {});
      // Brief pause for modal animation to complete
      await page.waitForTimeout(300);
    }
  }
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

  // Check for error toast (data-testid based)
  const errorToast = page.locator(SELECTORS.errorToast).first();
  if (await errorToast.isVisible({ timeout: 100 }).catch(() => false)) {
    const errorText = (await errorToast.innerText().catch(() => '')).trim();
    // Skip empty text -- likely a non-error ARIA element, not a real toast
    if (errorText) {
      throw new Error(`ChatGPT error: ${errorText}`);
    }
  }

  // Check for "Something went wrong" inside the last assistant turn.
  // Scoped to the turn container to avoid matching the entire page body.
  const lastTurn = page.locator(SELECTORS.assistantTurn).last();
  if (await lastTurn.count() > 0) {
    const turnText = await lastTurn.innerText({ timeout: 200 }).catch(() => '');
    if (turnText.includes('Something went wrong')) {
      throw new Error('ChatGPT error: Something went wrong while processing your request.');
    }
  }
}
