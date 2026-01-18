#!/usr/bin/env node

/**
 * ask-question CLI
 *
 * Sends prompts to the ask-question-server daemon via HTTP.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { Agent } from 'undici';

const SERVER_URL = process.env.ASK_QUESTION_SERVER_URL || 'http://127.0.0.1:3033';

// Custom dispatcher to disable Undici's hidden timeouts.
// Node's fetch() uses Undici which defaults headersTimeout and bodyTimeout to
// 300s (5 min). For long-running requests (4-10+ min), this causes "fetch failed"
// errors even though our AbortSignal.timeout is much longer.
const longRequestDispatcher = new Agent({
  headersTimeout: 0, // Disable Undici's 5-min header timeout
  bodyTimeout: 0,    // Disable Undici's body inactivity timeout
});

function usage() {
  console.log(`Usage: ask-question [options] [prompt...]

Send a prompt to ChatGPT and get the response.

Options:
  -f, --file <path>     Read prompt from file
  -o, --output <path>   Write response to file
  -t, --timeout <ms>    Response timeout (default: 1200000 / 20 min)
  --continue            Continue existing chat (default: start new chat)
  -h, --help            Show this help

Examples:
  ask-question "What is the capital of France?"
  ask-question -f question.md -o answer.md
  echo "Explain async/await" | ask-question
`);
  process.exit(0);
}

function parseCLIArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      file: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      timeout: { type: 'string', short: 't' },
      continue: { type: 'boolean' },
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
    timeout: values.timeout ? parseInt(values.timeout, 10) : 1200000,
    newChat: !values.continue
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


async function askServer(prompt, opts = {}) {
  const { timeout = 1200000, newChat = false, maxRetries = 2 } = opts;
  const requestId = crypto.randomBytes(4).toString('hex');

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.error(`[ask-question] [${requestId}] Attempt ${attempt}/${maxRetries}...`);
      const res = await fetch(`${SERVER_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, timeout, newChat, requestId }),
        signal: AbortSignal.timeout(timeout + 10000), // Extra buffer for HTTP overhead
        dispatcher: longRequestDispatcher, // Disable Undici's 5-min hidden timeouts
      });

      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || 'Unknown server error');
      }

      console.error(`[ask-question] [${requestId}] Success`);
      return data.text;
    } catch (e) {
      lastError = e;

      // Log detailed error info to diagnose connection failures
      // Key insight: Node's fetch() uses Undici which has hidden timeouts
      // (headersTimeout/bodyTimeout default to 5 min). If cause.code is
      // UND_ERR_HEADERS_TIMEOUT, that's the culprit.
      console.error(`[ask-question] [${requestId}] Error: ${e.message}`);
      if (e.cause) {
        console.error(`[ask-question] [${requestId}] Cause: ${e.cause.message || e.cause}`);
        console.error(`[ask-question] [${requestId}] Cause code: ${e.cause.code || 'none'}`);
      }

      // Only retry on connection-level failures, not server errors
      const isConnectionError = e.message.includes('fetch failed') ||
                                e.message.includes('ECONNREFUSED') ||
                                e.message.includes('ECONNRESET') ||
                                e.cause?.code === 'ECONNREFUSED' ||
                                e.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
                                e.cause?.code === 'UND_ERR_BODY_TIMEOUT';

      if (isConnectionError && attempt < maxRetries) {
        const delayMs = attempt * 1000; // 1s, 2s, ...
        console.error(`[ask-question] [${requestId}] Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
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
    console.error('Start it with: ask-question-server');
    process.exit(1);
  }

  console.error(`[ask-question] Sending prompt (${prompt.length} chars)`);

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
      console.error(`[ask-question] Response saved to: ${args.output}`);
    }

  } catch (e) {
    console.error(`[ask-question] Error: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[ask-question] Error: ${e.message}`);
  process.exit(1);
});
