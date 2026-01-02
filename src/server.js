#!/usr/bin/env node

/**
 * ChatGPT Relay Server
 *
 * HTTP daemon that owns a persistent browser context and serializes
 * requests to ChatGPT. CLI communicates via HTTP, not WebSocket connect.
 */

import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { navigateToNewChat, sendPromptAndWait } from './chatgpt.js';

const USER_DATA_DIR = process.env.CGPT_USER_DATA_DIR ||
  path.join(os.homedir(), '.chatgpt-relay/user-data');

const PORT = parseInt(process.env.CGPT_PORT || '3033', 10);
const SHUTDOWN_TIMEOUT_MS = 5000;

let context = null;
let page = null;
let requestQueue = Promise.resolve();
let shuttingDown = false;

/**
 * Process a prompt request (serialized via queue).
 */
async function processRequest(prompt, opts = {}) {
  const { timeout = 120000, newChat = false } = opts;

  // Ensure we have a page
  if (!page || page.isClosed()) {
    page = await context.newPage();
    await page.goto('https://chatgpt.com');
  }

  if (newChat) {
    await navigateToNewChat(page);
  }

  const response = await sendPromptAndWait(page, prompt, { timeout });
  return response;
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

    try {
      console.log(`[cgpt-server] Processing prompt (${data.prompt.length} chars)...`);
      const response = await queueRequest(data.prompt, {
        timeout: data.timeout,
        newChat: data.newChat
      });
      console.log(`[cgpt-server] Response received (${response.length} chars)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text: response }));
    } catch (e) {
      console.error(`[cgpt-server] Error:`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

async function main() {
  // Ensure user data directory exists
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[cgpt-server] Starting browser with persistent profile...');
  console.log(`[cgpt-server] User data: ${USER_DATA_DIR}`);

  // Launch persistent context (supports user data dir for login persistence)
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-infobars',
      '--noerrdialogs'
    ]
  });

  // Open ChatGPT page
  page = context.pages()[0] || await context.newPage();
  await page.goto('https://chatgpt.com');
  console.log('[cgpt-server] ChatGPT page opened. Log in if needed.');

  // Start HTTP server
  const server = http.createServer(handleRequest);

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[cgpt-server] HTTP server listening on http://127.0.0.1:${PORT}`);
    console.log('[cgpt-server] Endpoints:');
    console.log('  POST /ask    - Send prompt, get response');
    console.log('  GET  /health - Health check');
    console.log('[cgpt-server] Ready. Press Ctrl+C to stop.');
  });

  // Shutdown handler
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('\n[cgpt-server] Shutting down...');

    const hardTimeout = setTimeout(() => {
      console.error('[cgpt-server] Force exiting after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      server.close();
      if (context) {
        await context.close();
      }
      process.exitCode = 0;
    } finally {
      clearTimeout(hardTimeout);
    }
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('uncaughtException', (e) => {
    console.error('[cgpt-server] Uncaught exception:', e);
    shutdown();
  });
  process.once('unhandledRejection', (e) => {
    console.error('[cgpt-server] Unhandled rejection:', e);
    shutdown();
  });
}

main().catch((e) => {
  console.error('[cgpt-server] Error:', e);
  process.exit(1);
});
