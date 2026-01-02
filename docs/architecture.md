# ChatGPT Relay Architecture

## Problem

When using Claude Code for development, research questions often arise that benefit from web search capabilities. The current workflow requires manual copy-paste between terminal and browser:

1. Claude Code drafts a question (via `/ask-question` command)
2. **Manual**: Copy question to ChatGPT in browser
3. **Manual**: Wait for response, copy back
4. Save answer to companion file
5. Continue working in Claude Code

This breaks flow and requires the developer to babysit the research process.

## Solution

Build a relay system that automates ChatGPT interaction via Playwright, allowing Claude Code to "send out" research questions and receive notifications when answers are ready.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  Claude Code                                                            │
│      │                                                                  │
│      ▼                                                                  │
│  /ask-question (or /ask-chatgpt)                                        │
│      │                                                                  │
│      ▼                                                                  │
│  /tmp/stackexchange-*-question.md                                       │
│      │                                                                  │
│      ▼                                                                  │
│  CLI (cgpt) ─────► HTTP POST /ask ─────► cgpt-server (daemon)           │
│                                               │                         │
│                                               ▼                         │
│                                         Chromium (headless)             │
│                                         + storageState session          │
│                                               │                         │
│                                               ▼                         │
│                                         ChatGPT tab                     │
│                                         (DOM automation)                │
│                                               │                         │
│                                               ▼                         │
│                                         Extract response                │
│                                               │                         │
│      ┌────────────────────────────────────────┘                         │
│      │                                                                  │
│      ▼                                                                  │
│  /tmp/stackexchange-*-answer.md                                         │
│      │                                                                  │
│      ├──────► pbcopy (clipboard)                                        │
│      │                                                                  │
│      ▼                                                                  │
│  POST localhost:3001/research-complete                                  │
│      │                                                                  │
│      ▼                                                                  │
│  Claude Code ◄──────────────────── Claude-Code-Remote                   │
│  (receives "Answer ready" notification)                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Login Helper (`cgpt-login`)

One-time interactive login flow:
- Launches headed (visible) Chromium browser
- User logs into ChatGPT manually
- Auto-detects login completion (URL + composer visibility)
- Saves session via Playwright `storageState` to `~/.chatgpt-relay/storage-state.json`
- Only needed once; session persists across server restarts

### 2. HTTP Daemon (`cgpt-server`)

A long-lived Node process that:
- Launches **headless** Chromium (no window, no focus-stealing)
- Loads saved session from `storageState` file
- Exposes HTTP endpoints on `127.0.0.1:3033`:
  - `POST /ask` - Send prompt, get response (queued/serialized)
  - `GET /health` - Health check
- Serializes requests via promise queue (one prompt at a time)
- Keeps the browser alive between requests

**Why HTTP daemon vs WebSocket connect:**
- `launchServer()` doesn't support `--user-data-dir` or `storageState`
- HTTP is simpler to debug (curl-friendly)
- Request queue prevents race conditions
- Server owns browser lifecycle completely

### 3. CLI (`cgpt`)

The command-line tool that:
- Sends prompts to daemon via `POST /ask`
- Checks server health before sending
- Extracts the response text
- Saves to file, copies to clipboard
- Notifies Claude-Code-Remote if session ID available

### 4. Claude-Code-Remote Integration (TODO)

Minor addition to existing webhook server:
- New `/research-complete` endpoint
- Accepts `{ session_id, answer_file, source }`
- Injects notification into Claude session

## Data Flow

1. Claude Code runs `/ask-chatgpt bazel-query-performance`
2. Command writes question to `/tmp/...question.md`
3. Command invokes `cgpt --file ... --output ... --session $SESSION_ID`
4. CLI POSTs to `http://127.0.0.1:3033/ask`
5. Server navigates to ChatGPT, injects prompt, waits for response
6. Server returns response as JSON
7. CLI saves to file, copies to clipboard
8. CLI POSTs to Claude-Code-Remote `/research-complete`
9. Claude-Code-Remote injects notification into Claude session
10. Claude Code reads the answer file and continues

## Design Decisions

### HTTP Daemon over WebSocket Connect
**Decision: Use HTTP daemon with storageState**
- `launchServer()` doesn't support persistent sessions
- HTTP is curl-debuggable and simpler
- Request queue handles serialization naturally
- Browser runs headless (no focus-stealing!)

### Headless with StorageState
**Decision: Separate login from daemon**
- `cgpt-login`: One-time headed browser for manual login, saves cookies
- `cgpt-server`: Headless browser loads saved session
- Eliminates focus-stealing during normal operation
- Session persists across server restarts

### Session ID Discovery
**Decision: Automatic via runtime files**
- CLI reads `~/.claude/runtime/ppid-map/$PPID` to find session ID
- Falls back to pane-map if in tmux
- Matches existing Claude-Code-Remote session discovery pattern

## Project Structure

```
chatgpt-relay/
├── docs/
│   ├── architecture.md
│   └── plans/
├── src/
│   ├── server.js      # HTTP daemon (headless browser)
│   ├── login.js       # One-time login helper (headed browser)
│   ├── cgpt.js        # CLI tool (HTTP client)
│   ├── chatgpt.js     # ChatGPT DOM automation
│   ├── session.js     # Claude session discovery
│   └── session.test.js
├── package.json
└── .gitignore
```

## Reliability Considerations

### Robust (Low Maintenance)
- HTTP communication between CLI and daemon
- StorageState session persistence
- File I/O and clipboard
- Session discovery from runtime files
- Request queue serialization

### Fragile (Requires Maintenance)
- ChatGPT DOM selectors (composer, send button, message container)
- Completion detection heuristics
- Message extraction
- Login detection heuristics

**Mitigation:**
- Use semantic selectors where possible (data-testid, aria-label)
- Multiple selector fallbacks (OR logic)
- Error state detection (toasts, session expiry, "Continue generating")
- Clear error messages when selectors fail
- Configurable timeouts

## Technology Choices

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Browser automation | Playwright | Native protocol, storageState support |
| CLI | Node.js | Matches server, single runtime |
| Browser | Chromium (bundled) | Playwright controls version, consistent behavior |
| IPC | HTTP | Simple, debuggable, curl-friendly |

## Security Considerations

- HTTP server binds to localhost only (127.0.0.1)
- No CORS headers (localhost-only access)
- StorageState file in user-writable directory (~/.chatgpt-relay/)
- No credentials stored (ChatGPT session cookies in storageState)

## Limitations

- **Chromium only** - No Firefox support (acceptable trade-off for simplicity)
- **Dedicated browser** - Not your normal Chrome; separate Chromium instance
- **DOM fragility** - ChatGPT UI changes will break selectors (accepted)
- **Single request at a time** - Queue serializes prompts

## Future Enhancements

- Support for other research tools (Perplexity, Claude.ai web)
- Response streaming (show progress)
- Conversation threading (continue existing chat)
- Request cancellation via watchdog
- Modal/interstitial dismissal helpers
