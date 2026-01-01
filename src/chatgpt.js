/**
 * ChatGPT DOM automation helpers.
 */

const CHATGPT_URL = 'https://chatgpt.com';

/**
 * Find or create a ChatGPT page in the browser.
 * @param {import('playwright').Browser} browser
 * @returns {Promise<import('playwright').Page>}
 */
export async function getOrCreateChatGPTPage(browser) {
  const contexts = browser.contexts();

  // Look for existing ChatGPT tab
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (page.url().startsWith(CHATGPT_URL)) {
        await page.bringToFront();
        return page;
      }
    }
  }

  // No existing tab, create one
  const context = contexts[0] || await browser.newContext();
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

  // Find composer - try multiple selectors
  const composerSelectors = [
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][data-placeholder]',
    'textarea'
  ];

  let composer = null;
  for (const sel of composerSelectors) {
    try {
      composer = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' });
      if (composer) break;
    } catch {
      // Try next selector
    }
  }

  if (!composer) {
    throw new Error('Could not find ChatGPT composer. Are you logged in?');
  }

  // Clear and fill composer
  await composer.click();
  await composer.fill(prompt);

  // Small delay for React to process
  await page.waitForTimeout(100);

  // Find and click send button
  const sendSelectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]'
  ];

  let sent = false;
  for (const sel of sendSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isEnabled()) {
        await btn.click();
        sent = true;
        break;
      }
    } catch {
      // Try next selector
    }
  }

  if (!sent) {
    // Fallback: press Enter
    await composer.press('Enter');
  }

  // Wait for response to complete
  const response = await waitForResponse(page, timeout);
  return response;
}

/**
 * Wait for the assistant's response to complete.
 * @param {import('playwright').Page} page
 * @param {number} timeout
 * @returns {Promise<string>}
 */
async function waitForResponse(page, timeout) {
  const startTime = Date.now();
  let lastText = '';
  let stableCount = 0;

  while (Date.now() - startTime < timeout) {
    await page.waitForTimeout(500);

    // Check if still generating
    const isGenerating = await page.$('[data-testid="stop-button"], button[aria-label*="Stop"]');

    // Get latest assistant message
    const messages = await page.$$('[data-message-author-role="assistant"]');
    const lastMessage = messages[messages.length - 1];

    if (lastMessage) {
      const currentText = await lastMessage.textContent() || '';

      if (!isGenerating && currentText.length > 0) {
        // Generation stopped with content
        return currentText;
      }

      // Check for stability (text unchanged for 3 cycles = 1.5s)
      if (currentText === lastText && currentText.length > 0) {
        stableCount++;
        if (stableCount >= 3 && !isGenerating) {
          return currentText;
        }
      } else {
        stableCount = 0;
        lastText = currentText;
      }
    }
  }

  // Timeout - return whatever we have
  const messages = await page.$$('[data-message-author-role="assistant"]');
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    return await lastMessage.textContent() || '';
  }

  throw new Error('Timeout waiting for ChatGPT response');
}
