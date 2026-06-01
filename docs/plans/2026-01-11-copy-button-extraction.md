# Copy Button Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract ChatGPT responses via the copy button to preserve markdown formatting instead of using `innerText()`.

**Architecture:** After response stabilization, hover the message to reveal action buttons, click the copy button (`data-testid="copy-turn-action-button"`), poll clipboard until it changes, and return the copied text. Fall back to `innerText()` if clipboard extraction fails. Requires adding clipboard permissions to browser context.

**Tech Stack:** Playwright (clipboard permissions, locators), Node.js

---

## Task 1: Add Clipboard Permissions to Browser Context

**Files:**
- Modify: `src/server.js:168-170`

**Step 1: Modify browser context creation**

In `src/server.js`, update the `newContext()` call to include clipboard permissions:

```javascript
  // Create context with saved cookies/localStorage
  context = await browser.newContext({
    storageState: STORAGE_STATE_FILE,
    permissions: ['clipboard-read', 'clipboard-write']
  });
```

Note: We grant permissions at context creation rather than origin-scoped because we always operate on chatgpt.com. If domain changes become an issue, we can switch to `context.grantPermissions([...], { origin })` after navigation.

**Step 2: Verify server starts successfully**

Run: `ask-question-server`
Expected: Server starts without errors, logs "Ready. Press Ctrl+C to stop."

**Step 3: Commit**

```bash
git add src/server.js
git commit -m "Add clipboard permissions to browser context"
```

---

## Task 2: Add Copy Button Selector

**Files:**
- Modify: `src/chatgpt.js:40-79`

**Step 1: Add copy button selector to SELECTORS object**

In `src/chatgpt.js`, add a new entry to the `SELECTORS` object after `continueButton`:

```javascript
  continueButton: [
    'button:has-text("Continue generating")',
    'button:has-text("Continue")',
    '[data-testid="continue-button"]'
  ].join(', '),

  copyTurnButton: '[data-testid="copy-turn-action-button"]',

  loginButton: [
```

**Step 2: Commit**

```bash
git add src/chatgpt.js
git commit -m "Add copy button selector for response extraction"
```

---

## Task 3: Implement Clipboard Extraction with Fallback

**Files:**
- Modify: `src/chatgpt.js`

**Step 1: Add clipboard read helper function**

Before the `waitForResponse` function (around line 173), add a helper to safely read clipboard:

```javascript
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
```

**Step 2: Add the extraction helper function**

After the `readClipboardText` function, add the main extraction helper:

```javascript
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
    // Hover to reveal action buttons (ChatGPT hides them until hover)
    await messageLocator.hover({ timeout: 2000 }).catch(() => {});

    // Scope copy button to this message container (not global .last())
    const copyBtn = messageLocator.locator(SELECTORS.copyTurnButton);

    // Use waitFor, not isVisible(timeout) - timeout is ignored in isVisible
    await copyBtn.waitFor({ state: 'visible', timeout: 1500 });

    // Ensure document focus (helps with Clipboard API in some cases)
    await page.click('body', { position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});

    // Snapshot clipboard before click
    const before = await readClipboardText(page);

    await copyBtn.click({ timeout: 1500 });

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
```

**Step 3: Modify the stabilization loop to use the helper**

In `waitForResponse`, replace the final return in the stabilization loop (around lines 284-287):

Before:
```javascript
      if (stableMs >= stabilityThreshold) {
        console.log(`[chatgpt] Response stabilized (${currentText.length} chars)`);
        return currentText;
      }
```

After:
```javascript
      if (stableMs >= stabilityThreshold) {
        console.log(`[chatgpt] Response stabilized (${currentText.length} chars)`);
        return await extractResponseText(page, lastAssistant);
      }
```

**Step 4: Modify the timeout fallback to use the helper**

Replace the timeout return (around lines 297-301):

Before:
```javascript
  // Timeout - return whatever we have
  const finalText = (await lastAssistant.innerText().catch(() => '')).trim();
  if (finalText) {
    console.log(`[chatgpt] Timeout but have partial response (${finalText.length} chars)`);
    return finalText;
  }
```

After:
```javascript
  // Timeout - return whatever we have
  const finalText = await extractResponseText(page, lastAssistant).catch(() => '');
  if (finalText) {
    console.log(`[chatgpt] Timeout but have partial response (${finalText.length} chars)`);
    return finalText;
  }
```

**Step 5: Commit**

```bash
git add src/chatgpt.js
git commit -m "Extract response via copy button with innerText fallback

Clicking the copy button preserves markdown formatting (code blocks,
lists, etc.) whereas innerText() loses structure.

Key robustness improvements from code review:
- Hover message to reveal action buttons
- Scope copy button to message container (not global .last())
- Use waitFor instead of isVisible(timeout) which ignores timeout
- Poll clipboard for changes instead of fixed 100ms wait
- Focus page before clipboard operation
- Falls back to innerText if clipboard extraction fails"
```

---

## Task 4: Manual Integration Test

**Files:**
- None (manual testing)

**Step 1: Restart the server**

If server is running, stop it (Ctrl+C) and restart:
```bash
ask-question-server
```

Expected: Server starts, shows "Ready."

**Step 2: Send a test prompt with code**

```bash
ask-question "Write a hello world function in Python with a docstring"
```

Expected:
- Response contains markdown-formatted code block (triple backticks)
- Server logs show "Extracted via copy button"
- Response looks like:
  ```
  ```python
  def hello_world():
      """Print a greeting to the console."""
      print("Hello, World!")
  ```
  ```

**Step 3: Verify fallback works (optional)**

To test fallback, temporarily change the selector to something invalid:
```javascript
copyTurnButton: '[data-testid="nonexistent-button"]',
```

Send another prompt and verify:
- Server logs show "Copy button extraction failed" and "falling back to innerText"
- Response is still returned (plain text without markdown fencing)

Revert the selector change after testing.

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Add clipboard permissions to browser context |
| 2 | Add copy button selector |
| 3 | Implement extraction helper with fallback |
| 4 | Manual integration test |

**Key design decisions (revised based on ChatGPT code review):**
- Hover message before looking for copy button (ChatGPT hides action buttons)
- Scope copy button to message container (avoids `.last()` brittleness)
- Use `waitFor({ state: 'visible' })` not `isVisible({ timeout })` (timeout is ignored in isVisible)
- Poll clipboard for changes instead of fixed wait (handles async clipboard writes)
- Focus page before clipboard operation (helps with Clipboard API rules)
- Fallback to `innerText()` ensures robustness if copy fails
- Uses `data-testid` selector (stable, maintained for testing)
