#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { discoverSessionId } from './session.js';
import { getOrCreateChatGPTPage, navigateToNewChat, sendPromptAndWait } from './chatgpt.js';

const WS_ENDPOINT_FILE = process.env.CGPT_WS_ENDPOINT_FILE ||
  path.join(os.tmpdir(), 'cgpt-ws-endpoint');

function usage() {
  console.log(`Usage: cgpt [options] [prompt]

Send a prompt to ChatGPT and get the response.

Options:
  -f, --file <path>     Read prompt from file
  -o, --output <path>   Write response to file
  -s, --session <id>    Claude session ID (auto-detected if omitted)
  -t, --timeout <ms>    Response timeout (default: 120000)
  --new-chat            Start a new chat (don't reuse existing)
  -h, --help            Show this help

Examples:
  cgpt "What is the capital of France?"
  cgpt -f question.md -o answer.md
  echo "Explain async/await" | cgpt
`);
  process.exit(0);
}

function parseArgs(args) {
  const result = {
    prompt: null,
    file: null,
    output: null,
    session: null,
    timeout: 120000,
    newChat: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      usage();
    } else if (arg === '-f' || arg === '--file') {
      result.file = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      result.output = args[++i];
    } else if (arg === '-s' || arg === '--session') {
      result.session = args[++i];
    } else if (arg === '-t' || arg === '--timeout') {
      result.timeout = parseInt(args[++i], 10);
    } else if (arg === '--new-chat') {
      result.newChat = true;
    } else if (!arg.startsWith('-')) {
      result.prompt = arg;
    }
  }

  return result;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const proc = spawn('pbcopy');
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with ${code}`));
    });
  });
}

async function notifyClaudeCodeRemote(sessionId, answerFile) {
  try {
    const res = await fetch('http://localhost:3001/research-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        answer_file: answerFile,
        source: 'chatgpt'
      })
    });

    if (!res.ok) {
      console.error(`[cgpt] Warning: Could not notify Claude-Code-Remote: HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[cgpt] Warning: Could not notify Claude-Code-Remote: ${e.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Get prompt
  let prompt = args.prompt;
  if (args.file) {
    prompt = fs.readFileSync(args.file, 'utf8').trim();
  } else if (!prompt) {
    prompt = await readStdin();
  }

  if (!prompt) {
    console.error('Error: No prompt provided');
    usage();
  }

  // Read WebSocket endpoint
  if (!fs.existsSync(WS_ENDPOINT_FILE)) {
    console.error('Error: Browser server not running.');
    console.error('Start it with: cgpt-server');
    process.exit(1);
  }

  const wsEndpoint = fs.readFileSync(WS_ENDPOINT_FILE, 'utf8').trim();

  // Discover session ID
  const sessionId = args.session || discoverSessionId();

  console.error(`[cgpt] Connecting to browser server...`);
  const browser = await chromium.connect(wsEndpoint);

  try {
    console.error(`[cgpt] Finding ChatGPT tab...`);
    const page = await getOrCreateChatGPTPage(browser);

    if (args.newChat) {
      console.error(`[cgpt] Starting new chat...`);
      await navigateToNewChat(page);
    }

    console.error(`[cgpt] Sending prompt (${prompt.length} chars)...`);
    const response = await sendPromptAndWait(page, prompt, { timeout: args.timeout });

    // Output response
    console.log(response);

    // Save to file if specified
    if (args.output) {
      fs.writeFileSync(args.output, response, 'utf8');
      console.error(`[cgpt] Response saved to: ${args.output}`);
    }

    // Copy to clipboard
    try {
      await pbcopy(response);
      console.error('[cgpt] Response copied to clipboard');
    } catch (e) {
      console.error(`[cgpt] Warning: Could not copy to clipboard: ${e.message}`);
    }

    // Notify Claude-Code-Remote if session available
    if (sessionId) {
      console.error(`[cgpt] Notifying Claude session: ${sessionId}`);
      await notifyClaudeCodeRemote(sessionId, args.output);
    }

  } finally {
    // Don't close browser - leave it running for next request
    // Just disconnect this client
  }
}

main().catch((e) => {
  console.error(`[cgpt] Error: ${e.message}`);
  process.exit(1);
});
