#!/usr/bin/env node

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const USER_DATA_DIR = process.env.CGPT_USER_DATA_DIR ||
  path.join(os.homedir(), '.chatgpt-relay/user-data');

const WS_ENDPOINT_FILE = process.env.CGPT_WS_ENDPOINT_FILE ||
  path.join(os.tmpdir(), 'cgpt-ws-endpoint');

async function main() {
  // Ensure user data directory exists
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log('[cgpt-server] Starting browser server...');
  console.log(`[cgpt-server] User data: ${USER_DATA_DIR}`);

  const server = await chromium.launchServer({
    headless: false, // Show browser for login
    args: [
      `--user-data-dir=${USER_DATA_DIR}`,
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const wsEndpoint = server.wsEndpoint();

  // Write endpoint to file for CLI to read
  fs.writeFileSync(WS_ENDPOINT_FILE, wsEndpoint);
  console.log(`[cgpt-server] WebSocket endpoint: ${wsEndpoint}`);
  console.log(`[cgpt-server] Endpoint file: ${WS_ENDPOINT_FILE}`);
  console.log('[cgpt-server] Browser server ready. Press Ctrl+C to stop.');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[cgpt-server] Shutting down...');
    try { fs.unlinkSync(WS_ENDPOINT_FILE); } catch {}
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[cgpt-server] Shutting down...');
    try { fs.unlinkSync(WS_ENDPOINT_FILE); } catch {}
    await server.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[cgpt-server] Error:', e);
  process.exit(1);
});
