#!/usr/bin/env node

/**
 * ChatGPT Relay CLI
 *
 * Sends prompts to the cgpt-server daemon via HTTP.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { discoverSessionId } from './session.js';

const SERVER_URL = process.env.CGPT_SERVER_URL || 'http://127.0.0.1:3033';

function usage() {
  console.log(`Usage: cgpt [options] [prompt...]

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
  cgpt What is the capital of France?
  cgpt -f question.md -o answer.md
  echo "Explain async/await" | cgpt
`);
  process.exit(0);
}

function parseCLIArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      file: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      session: { type: 'string', short: 's' },
      timeout: { type: 'string', short: 't' },
      'new-chat': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    usage();
  }

  return {
    prompt: positionals.join(' ') || null,
    file: values.file ?? null,
    output: values.output ?? null,
    session: values.session ?? null,
    timeout: values.timeout ? parseInt(values.timeout, 10) : 120000,
    newChat: values['new-chat'] ?? false
  };
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

async function askServer(prompt, opts = {}) {
  const { timeout = 120000, newChat = false } = opts;

  const res = await fetch(`${SERVER_URL}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, timeout, newChat }),
    signal: AbortSignal.timeout(timeout + 10000) // Extra buffer for HTTP overhead
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(data.error || 'Unknown server error');
  }

  return data.text;
}

async function checkServerHealth() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseCLIArgs(process.argv.slice(2));

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

  // Check server is running
  const serverOk = await checkServerHealth();
  if (!serverOk) {
    console.error('Error: Server not running or not responding.');
    console.error('Start it with: cgpt-server');
    process.exit(1);
  }

  // Discover session ID
  const sessionId = args.session || discoverSessionId();

  console.error(`[cgpt] Sending prompt (${prompt.length} chars)...`);

  try {
    const response = await askServer(prompt, {
      timeout: args.timeout,
      newChat: args.newChat
    });

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

  } catch (e) {
    console.error(`[cgpt] Error: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[cgpt] Error: ${e.message}`);
  process.exit(1);
});
