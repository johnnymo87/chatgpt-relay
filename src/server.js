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
let tail = Promise.resolve();
let shuttingDown = false;

// Browser launch configuration, extracted for reuse in recovery.
function getBrowserLaunchOptions() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  return {
    headless: true,
    executablePath,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu'
    ]
  };
}

/**
 * Ensure the browser is alive and connected. If the browser has crashed
 * or been killed, relaunch it and recreate the context.
 * This prevents the daemon from becoming permanently stuck after a
 * browser crash (cgpt-wzp).
 */
async function ensureBrowserAlive() {
  if (browser && browser.isConnected()) return;

  console.log('[ask-question-server] Browser disconnected, relaunching...');

  // Clean up dead references
  page = null;

  // Attempt to close stale browser (may no-op if already dead)
  try { await browser?.close(); } catch { /* already dead */ }

  browser = await chromium.launch(getBrowserLaunchOptions());
  context = await browser.newContext({
    storageState: STORAGE_STATE_FILE,
    permissions: ['clipboard-read', 'clipboard-write']
  });

  console.log('[ask-question-server] Browser relaunched successfully.');
}

/**
 * Process a prompt request (serialized via queue).
 */
async function processRequest(prompt, opts = {}) {
  const { timeout = 1200000, newChat = false, requestId = '?' } = opts;
  const log = (msg) => console.log(`[ask-question-server] [${requestId}] ${msg}`);

  // Ensure browser is still alive (recovers from crashes)
  await ensureBrowserAlive();

  // Ensure we have a page
  if (!page || page.isClosed()) {
    log('Creating new page...');
    page = await context.newPage();
    await page.goto('https://chatgpt.com');
    await page.waitForLoadState('domcontentloaded');

    // Wait for the composer to be ready before accepting the request.
    // ChatGPT's SPA needs time to hydrate after page load.
    try {
      await page.locator('div#prompt-textarea[contenteditable="true"]')
        .first().waitFor({ state: 'visible', timeout: 15000 });
      log('Page ready (composer visible).');
    } catch {
      log('Warning: composer not visible after 15s on new page, proceeding anyway.');
    }
  }

  if (newChat) {
    log('Navigating to new chat...');
    await navigateToNewChat(page);
  }

  // Debug: log page state before processing
  log(`Processing... URL=${page.url()}`);

  try {
    const response = await sendPromptAndWait(page, prompt, { timeout });
    // Log a preview for debugging (helps identify truncated/status responses)
    const preview = response.length > 200
      ? response.substring(0, 200) + '...'
      : response;
    log(`Response preview (${response.length} chars): ${preview.replace(/\n/g, '\\n')}`);
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
 * Wrap a promise-producing function with a hard watchdog timeout.
 * When the watchdog fires, onTimeout is called (should close the page
 * to cancel in-flight Playwright operations) and the promise rejects.
 *
 * This is different from Promise.race with a timeout because it
 * actively cleans up (closes the page) rather than just ignoring
 * the stuck operation.
 */
function withWatchdog(promiseFactory, ms, onTimeout) {
  let timer;
  return Promise.race([
    promiseFactory(),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout(); } catch { /* best effort */ }
        reject(new Error(`Watchdog timeout after ${Math.round(ms / 1000)}s`));
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * Queue a request to ensure serialization.
 *
 * Uses the "tail" pattern: the caller gets the actual job promise
 * (with real result/error), while the tail swallows errors to keep
 * the queue alive after failures. This prevents one failed request
 * from breaking the entire queue chain.
 *
 * Each request is wrapped in a watchdog that closes the page if the
 * request exceeds its timeout + a grace period. This is the only
 * reliable way to cancel in-flight Playwright operations.
 */
function queueRequest(prompt, opts) {
  const requestTimeout = opts?.timeout ?? 1200000;
  // Watchdog fires 30s after the request's own timeout, giving the
  // circuit breaker and normal error handling time to act first.
  const watchdogMs = requestTimeout + 30000;
  const enqueuedAt = Date.now();
  // Reject if waited longer than 5 minutes in queue before starting.
  // This prevents requests from piling up and becoming stale.
  const queueWaitMs = opts?.queueWaitMs ?? 300000;

  const job = tail.then(() => {
    // Skip work if client already disconnected while waiting in queue.
    if (opts?.signal?.aborted) {
      throw new Error('Client disconnected before processing started');
    }

    // Skip work if waited too long in queue (request is probably stale).
    const waitedMs = Date.now() - enqueuedAt;
    if (queueWaitMs && waitedMs > queueWaitMs) {
      const reqId = opts?.requestId ?? '?';
      console.log(`[ask-question-server] [${reqId}] Queue wait exceeded ${Math.round(queueWaitMs / 1000)}s (waited ${Math.round(waitedMs / 1000)}s), skipping`);
      throw new Error(`Queue wait exceeded ${Math.round(queueWaitMs / 1000)}s`);
    }

    return withWatchdog(
      () => processRequest(prompt, opts),
      watchdogMs,
      async () => {
        const reqId = opts?.requestId ?? '?';
        console.error(`[ask-question-server] [${reqId}] Watchdog fired after ${Math.round(watchdogMs / 1000)}s, closing page...`);
        try {
          if (page && !page.isClosed()) await page.close();
        } catch { /* already dead */ }
        page = null;
      }
    );
  });
  tail = job.catch(() => {}); // swallow for tail only — keeps queue alive
  return job; // caller gets actual result/error
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
    console.log(`[ask-question-server] [${reqId}] Received (${data.prompt.length} chars)`);

    // Client disconnect detection: abort queued work if client drops.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        console.log(`[ask-question-server] [${reqId}] Client disconnected`);
        ac.abort();
      }
    });

    // Send headers immediately and start heartbeat to keep connection
    // alive during long processing. JSON.parse handles leading whitespace,
    // so the client can parse the final JSON payload normally.
    // Note: we always send 200 since headers go out before we know the
    // outcome. The client checks data.ok, not the HTTP status code.
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      // Omit Content-Length to use chunked transfer encoding
    });
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      if (!res.writableFinished && !res.destroyed) {
        res.write(' ');
      }
    }, 15000);

    try {
      const response = await queueRequest(data.prompt, {
        timeout: data.timeout,
        newChat: data.newChat,
        requestId: reqId,
        signal: ac.signal,
      });
      clearInterval(heartbeat);
      console.log(`[ask-question-server] [${reqId}] Sending response (${response.length} chars)`);
      res.end(JSON.stringify({ ok: true, text: response }));
    } catch (e) {
      clearInterval(heartbeat);
      // If client already disconnected, don't try to write
      if (res.writableFinished || res.destroyed) {
        console.log(`[ask-question-server] [${reqId}] Error after client disconnect: ${e.message}`);
        return;
      }
      console.error(`[ask-question-server] [${reqId}] Error: ${e.message}`);
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

  // Launch browser
  // --disable-gpu: Required for background/daemon processes on macOS.
  //   Without it, GPU-accelerated rendering fails silently in backgrounded
  //   processes, causing ChatGPT's React DOM to never hydrate response text.
  // Note: anti-throttling flags (--disable-background-timer-throttling,
  // --disable-backgrounding-occluded-windows, --disable-renderer-backgrounding)
  // were removed because they also interfere with ChatGPT's React rendering
  // pipeline, causing the same empty DOM issue (March 2026).
  const launchOpts = getBrowserLaunchOptions();
  if (launchOpts.executablePath) {
    console.log(`[ask-question-server] Using Chromium: ${launchOpts.executablePath}`);
  }
  browser = await chromium.launch(launchOpts);

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

  // Wait for the composer to be ready. ChatGPT's SPA needs time to fully
  // hydrate after page load -- the login indicator can appear before React
  // has finished rendering the composer.
  try {
    await page.locator('div#prompt-textarea[contenteditable="true"]')
      .first().waitFor({ state: 'visible', timeout: 10000 });
    console.log('[ask-question-server] Composer ready.');
  } catch {
    console.log('[ask-question-server] Warning: composer not ready after 10s, continuing anyway.');
  }

  // Extra settling time for the SPA to fully initialize.
  await page.waitForTimeout(2000);

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
