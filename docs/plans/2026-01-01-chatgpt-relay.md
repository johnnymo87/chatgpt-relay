# ChatGPT Relay Implementation Plan (Playwright)

> **Status:** COMPLETED (2026-01-01)
>
> **Architecture Changed:** Original plan used `launchServer()` + WebSocket `connect()`.
> Actual implementation uses HTTP daemon + `storageState` because `launchServer()`
> doesn't support persistent sessions. See `docs/architecture.md` for current design.

**Goal:** Build a CLI that sends research questions to ChatGPT via Playwright and notifies Claude Code when answers are ready.

**Architecture (Original):** ~~Browser server daemon (`launchServer`) + CLI (`connect`)~~

**Architecture (Actual):** HTTP daemon (`chromium.launch` headless + `storageState`) + CLI (HTTP client) + one-time login helper

**Tech Stack:** Node.js, Playwright

---

## Project Structure

```
chatgpt-relay/
├── docs/
├── src/
│   ├── server.js      # Browser server daemon
│   ├── cgpt.js        # CLI tool
│   ├── chatgpt.js     # ChatGPT DOM automation
│   └── session.js     # Claude session discovery
├── package.json
└── .gitignore
```

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "chatgpt-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "cgpt": "./src/cgpt.js",
    "cgpt-server": "./src/server.js"
  },
  "scripts": {
    "server": "node src/server.js",
    "test": "node --test src/*.test.js"
  },
  "dependencies": {
    "playwright": "^1.40.0"
  }
}
```

**Step 2: Create .gitignore**

```
node_modules/
*.log
.DS_Store
user-data/
```

**Step 3: Install dependencies**

Run: `npm install`
Expected: playwright downloaded with Chromium browser

**Step 4: Initialize git and commit**

```bash
git init
git add package.json .gitignore docs/
git commit -m "chore: initial project setup with playwright"
```

---

## Task 2: Session Discovery Helper

**Files:**
- Create: `src/session.js`
- Create: `src/session.test.js`

**Step 1: Write failing test**

Create `src/session.test.js`:
```javascript
import { test, mock } from 'node:test';
import assert from 'node:assert';
import { discoverSessionId } from './session.js';

test('discoverSessionId returns null when no runtime files exist', () => {
  const result = discoverSessionId({ ppid: 99999 });
  // With a fake PPID, no file will exist
  assert.strictEqual(result, null);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test src/session.test.js`
Expected: FAIL with "Cannot find module './session.js'"

**Step 3: Implement session discovery**

Create `src/session.js`:
```javascript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Discover Claude Code session ID from runtime files.
 * @param {object} opts - Options
 * @param {number} opts.ppid - Parent process ID
 * @param {string} opts.tmux - TMUX env var
 * @param {string} opts.tmuxPane - TMUX_PANE env var
 * @returns {string|null} Session ID or null
 */
export function discoverSessionId(opts = {}) {
  const ppid = opts.ppid ?? process.ppid;
  const tmux = opts.tmux ?? process.env.TMUX;
  const tmuxPane = opts.tmuxPane ?? process.env.TMUX_PANE;
  const homeDir = os.homedir();

  // Try ppid-map first
  const ppidMapPath = path.join(homeDir, '.claude/runtime/ppid-map', String(ppid));
  if (fs.existsSync(ppidMapPath)) {
    return fs.readFileSync(ppidMapPath, 'utf8').trim();
  }

  // Try pane-map if in tmux
  if (tmux && tmuxPane) {
    const socketPath = tmux.split(',')[0];
    const socketName = path.basename(socketPath);
    const paneNum = tmuxPane.replace('%', '');
    const paneKey = `${socketName}-${paneNum}`;
    const paneMapPath = path.join(homeDir, '.claude/runtime/pane-map', paneKey);

    if (fs.existsSync(paneMapPath)) {
      return fs.readFileSync(paneMapPath, 'utf8').trim();
    }
  }

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test src/session.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/session.js src/session.test.js
git commit -m "feat: add Claude session discovery helper"
```

---

## Task 3: Browser Server Daemon

**Files:**
- Create: `src/server.js`

**Step 1: Implement browser server**

Create `src/server.js`:
```javascript
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
```

**Step 2: Make executable**

Run: `chmod +x src/server.js`

**Step 3: Test manually**

Run: `node src/server.js`
Expected: Chromium window opens, WebSocket endpoint printed

Stop with Ctrl+C.

**Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat: add browser server daemon with persistent profile"
```

---

## Task 4: ChatGPT DOM Automation

**Files:**
- Create: `src/chatgpt.js`

**Step 1: Implement ChatGPT automation**

Create `src/chatgpt.js`:
```javascript
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
```

**Step 2: Commit**

```bash
git add src/chatgpt.js
git commit -m "feat: add ChatGPT DOM automation helpers"
```

---

## Task 5: CLI Tool

**Files:**
- Create: `src/cgpt.js`

**Step 1: Implement CLI**

Create `src/cgpt.js`:
```javascript
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
```

**Step 2: Make executable**

Run: `chmod +x src/cgpt.js`

**Step 3: Commit**

```bash
git add src/cgpt.js
git commit -m "feat: add cgpt CLI tool"
```

---

## Task 6: Claude-Code-Remote Endpoint

**Files:**
- Modify: `~/Code/Claude-Code-Remote/src/channels/telegram/webhook.js` (or create new route file)

**Step 1: Add /research-complete endpoint**

Add to the Express app in Claude-Code-Remote:

```javascript
// POST /research-complete - Notify when research query completes
app.post('/research-complete', async (req, res) => {
  const { session_id, answer_file, source } = req.body;

  if (!session_id) {
    return res.status(400).json({ ok: false, error: 'session_id required' });
  }

  const session = this.registry.get(session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  const message = answer_file
    ? `Research complete (${source || 'chatgpt'}). Answer saved to: ${answer_file}`
    : `Research complete (${source || 'chatgpt'}). Answer copied to clipboard.`;

  try {
    await this.injectMessage(session, message);
    res.json({ ok: true });
  } catch (e) {
    this.logger.error(`Failed to inject research notification: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

**Step 2: Commit in Claude-Code-Remote**

```bash
cd ~/Code/Claude-Code-Remote
git add <modified files>
git commit -m "feat: add /research-complete endpoint for chatgpt-relay"
```

---

## Task 7: End-to-End Test

**Step 1: Start browser server**

Terminal 1:
```bash
cd /Users/jonathan.mohrbacher/Code/chatgpt-relay
node src/server.js
```

Expected: Chromium window opens.

**Step 2: Log into ChatGPT**

In the Chromium window, navigate to https://chatgpt.com and log in. This only needs to be done once.

**Step 3: Test CLI**

Terminal 2:
```bash
cd /Users/jonathan.mohrbacher/Code/chatgpt-relay
echo "What is 2+2? Reply with just the number." | node src/cgpt.js
```

Expected:
- ChatGPT tab receives prompt
- Response appears in terminal
- Response copied to clipboard

**Step 4: Test with file I/O**

```bash
echo "Explain the difference between let and const in JavaScript in one sentence." > /tmp/test-question.md
node src/cgpt.js -f /tmp/test-question.md -o /tmp/test-answer.md
cat /tmp/test-answer.md
```

Expected: Answer saved to file.

**Step 5: Final commit**

```bash
git add -A
git commit -m "chore: complete initial implementation"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Project setup | package.json, .gitignore |
| 2 | Session discovery | src/session.js |
| 3 | Browser server | src/server.js |
| 4 | ChatGPT automation | src/chatgpt.js |
| 5 | CLI tool | src/cgpt.js |
| 6 | Claude-Code-Remote endpoint | webhook.js modification |
| 7 | End-to-end test | Manual testing |

**Total: ~200 lines of code** (vs ~500+ for extension approach)
