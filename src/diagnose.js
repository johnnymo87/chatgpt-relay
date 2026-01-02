#!/usr/bin/env node

/**
 * Diagnostic script - connects to running server's browser via CDP
 * and dumps DOM state for debugging.
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

async function main() {
  console.log('Connecting to browser...');

  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();

    if (contexts.length === 0) {
      console.log('No browser contexts found');
      return;
    }

    const context = contexts[0];
    const pages = context.pages();

    console.log(`Found ${pages.length} pages`);

    for (const page of pages) {
      console.log(`\n=== Page: ${page.url()} ===\n`);

      // Take screenshot
      await page.screenshot({ path: '/tmp/chatgpt-debug.png', fullPage: true });
      console.log('Screenshot saved to /tmp/chatgpt-debug.png');

      // Check for assistant messages
      const assistantMsgs = await page.locator('[data-message-author-role="assistant"]').all();
      console.log(`\nAssistant messages found: ${assistantMsgs.length}`);

      for (let i = 0; i < assistantMsgs.length; i++) {
        const msg = assistantMsgs[i];
        const text = await msg.innerText().catch(() => '[error getting text]');
        const isVisible = await msg.isVisible().catch(() => false);
        console.log(`  [${i}] visible=${isVisible}, text=${text.slice(0, 100)}...`);
      }

      // Check for stop button
      const stopBtn = page.locator('[data-testid="stop-button"], button[aria-label*="Stop"]');
      const stopVisible = await stopBtn.isVisible().catch(() => false);
      console.log(`\nStop button visible: ${stopVisible}`);

      // Check for composer
      const composer = page.locator('div[contenteditable="true"][data-placeholder]').first();
      const composerVisible = await composer.isVisible().catch(() => false);
      const composerText = await composer.innerText().catch(() => '');
      console.log(`Composer visible: ${composerVisible}, text: "${composerText.slice(0, 50)}"`);

      // Dump relevant DOM structure
      const html = await page.evaluate(() => {
        const main = document.querySelector('main');
        if (!main) return 'No main element found';

        // Find conversation container
        const conv = main.querySelector('[class*="conversation"]') ||
                     main.querySelector('[class*="chat"]') ||
                     main;

        // Get a simplified view
        const msgs = document.querySelectorAll('[data-message-author-role]');
        return Array.from(msgs).map(m => ({
          role: m.getAttribute('data-message-author-role'),
          textLength: m.innerText?.length || 0,
          visible: m.offsetParent !== null,
          classes: m.className.slice(0, 100)
        }));
      });

      console.log('\nMessage elements in DOM:');
      console.log(JSON.stringify(html, null, 2));
    }

    await browser.close();
  } catch (e) {
    console.error('Error:', e.message);
    console.log('\nMake sure the server was started with --remote-debugging-port=9222');
  }
}

main();
