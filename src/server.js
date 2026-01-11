#!/usr/bin/env node

/**
 * ask-question-server
 *
 * HTTP daemon that owns a persistent browser context and serializes
 * requests to ChatGPT. CLI communicates via HTTP.
 */

import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { navigateToNewChat, sendPromptAndWait, isLoggedIn } from './chatgpt.js';

const STORAGE_STATE_FILE = process.env.ASK_QUESTION_STORAGE_STATE_FILE ||
  path.join(os.homedir(), '.chatgpt-relay/storage-state.json');

const PORT = parseInt(process.env.ASK_QUESTION_PORT || '3033', 10);
const SHUTDOWN_TIMEOUT_MS = 5000;

let browser = null;
let context = null;
let page = null;
let requestQueue = Promise.resolve();
let shuttingDown = false;

/**
 * Process a prompt request (serialized via queue).
 */
async function processRequest(prompt, opts = {}) {
  const { timeout = 1200000, newChat = false, requestId = '?' } = opts;
  const log = (msg) => console.log(`[ask-question-server] [${requestId}] ${msg}`);

  // Ensure we have a page
  if (!page || page.isClosed()) {
    log('Creating new page...');
    page = await context.newPage();
    await page.goto('https://chatgpt.com');
  }

  if (newChat) {
    log('Navigating to new chat...');
    await navigateToNewChat(page);
  }

  log('Processing...');
  try {
    const response = await sendPromptAndWait(page, prompt, { timeout });
    return response;
  } catch (e) {
    // Hard reset: close page to prevent cascading failures
    // Reload is not aggressive enough - ChatGPT's SPA can have stuck state
    // (websockets, React state, focus traps) that survives a reload
    log(`Error: ${e.message}, closing page to reset state...`);
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch (closeErr) {
      log(`Failed to close page: ${closeErr.message}`);
    }
    page = null; // Will be recreated on next request
    log('Page closed, will recreate on next request');
    throw e;
  }
}

/**
 * Queue a request to ensure serialization.
 */
function queueRequest(prompt, opts) {
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue
      .then(() => processRequest(prompt, opts))
      .then(resolve)
      .catch(reject);
  });
}

/**
 * Handle HTTP requests.
 */
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'ready' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/ask') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    if (!data.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing prompt' }));
      return;
    }

    const reqId = data.requestId || 'unknown';
    try {
      console.log(`[ask-question-server] [${reqId}] Received (${data.prompt.length} chars)`);
      const response = await queueRequest(data.prompt, {
        timeout: data.timeout,
        newChat: data.newChat,
        requestId: reqId
      });
      console.log(`[ask-question-server] [${reqId}] Sending response (${response.length} chars)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: response }));
    } catch (e) {
      console.error(`[ask-question-server] [${reqId}] Error: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

async function main() {
  // Check for storage state (session cookies from ask-question-login)
  if (!fs.existsSync(STORAGE_STATE_FILE)) {
    console.error('[ask-question-server] Error: No session found.');
    console.error(`[ask-question-server] Run 'ask-question-login' first to log into ChatGPT.`);
    console.error(`[ask-question-server] Expected: ${STORAGE_STATE_FILE}`);
    process.exit(1);
  }

  console.log('[ask-question-server] Starting headless browser...');
  console.log(`[ask-question-server] Using session: ${STORAGE_STATE_FILE}`);

  // Launch browser with anti-throttling flags
  // See: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });

  // Create context with saved cookies/localStorage
  context = await browser.newContext({
    storageState: STORAGE_STATE_FILE,
    permissions: ['clipboard-read', 'clipboard-write']
  });

  // Open ChatGPT page
  page = await context.newPage();
  await page.goto('https://chatgpt.com');
  await page.waitForLoadState('domcontentloaded');
  console.log('[ask-question-server] ChatGPT page opened.');

  // Verify we're logged in
  if (!(await isLoggedIn(page))) {
    console.error('[ask-question-server] Error: Not logged in to ChatGPT.');
    console.error('[ask-question-server] Session may have expired. Run "ask-question-login" to log in again.');
    await browser.close();
    process.exit(1);
  }
  console.log('[ask-question-server] Login verified.');

  // Start HTTP server
  const server = http.createServer(handleRequest);

  // Extend timeouts for long-running ChatGPT requests (can take 20+ minutes)
  server.timeout = 0; // Disable socket timeout (default is 0, but be explicit)
  server.keepAliveTimeout = 1260000; // 21 minutes - longer than max request timeout
  server.headersTimeout = 1290000; // Must be > keepAliveTimeout

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ask-question-server] HTTP server listening on http://127.0.0.1:${PORT}`);
    console.log('[ask-question-server] Endpoints:');
    console.log('  POST /ask    - Send prompt, get response');
    console.log('  GET  /health - Health check');
    console.log('[ask-question-server] Ready. Press Ctrl+C to stop.');
  });

  // Shutdown handler
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n[ask-question-server] Shutting down...');

    const hardTimeout = setTimeout(() => {
      console.error('[ask-question-server] Force exiting after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      server.close();
      if (browser) {
        await browser.close();
      }
      process.exitCode = 0;
    } finally {
      clearTimeout(hardTimeout);
    }
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('uncaughtException', (e) => {
    console.error('[ask-question-server] Uncaught exception:', e);
    shutdown();
  });
  process.once('unhandledRejection', (e) => {
    console.error('[ask-question-server] Unhandled rejection:', e);
    shutdown();
  });
}

main().catch((e) => {
  console.error('[ask-question-server] Error:', e);
  process.exit(1);
});
