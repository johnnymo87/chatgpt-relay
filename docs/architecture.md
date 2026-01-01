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
│  CLI (cgpt) ──────► Playwright connect() ──────► Browser Server         │
│                                                       │                 │
│                                                       ▼                 │
│                                                 Chromium                │
│                                            (persistent profile)         │
│                                                       │                 │
│                                                       ▼                 │
│                                                 ChatGPT tab             │
│                                                 (DOM automation)        │
│                                                       │                 │
│                                                       ▼                 │
│                                                 Extract response        │
│                                                       │                 │
│      ┌────────────────────────────────────────────────┘                 │
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

### 1. Browser Server (daemon)

A long-lived Node process that:
- Launches Chromium via Playwright's `browserType.launchServer()`
- Uses a persistent user data directory for ChatGPT login persistence
- Exposes a WebSocket endpoint for CLI connections
- Keeps the browser alive between requests

**Why launchServer vs connectOverCDP:**
- Higher fidelity than CDP (Playwright's native protocol)
- No Chrome 136+ remote debugging restrictions
- Cleaner lifecycle management
- Better error handling

### 2. CLI (`cgpt`)

The command-line tool that:
- Connects to the browser server via `browserType.connect(wsEndpoint)`
- Finds or creates a ChatGPT tab
- Injects the prompt and waits for response
- Extracts the response text
- Saves to file, copies to clipboard
- Notifies Claude-Code-Remote if session ID available

### 3. Claude-Code-Remote Integration

Minor addition to existing webhook server:
- New `/research-complete` endpoint
- Accepts `{ session_id, answer_file, source }`
- Injects notification into Claude session

## Data Flow

1. Claude Code runs `/ask-chatgpt bazel-query-performance`
2. Command writes question to `/tmp/...question.md`
3. Command invokes `cgpt --file ... --output ... --session $SESSION_ID`
4. CLI connects to browser server
5. CLI navigates to ChatGPT, injects prompt, waits for response
6. CLI extracts response, saves to file, copies to clipboard
7. CLI POSTs to Claude-Code-Remote
8. Claude-Code-Remote injects notification into Claude session
9. Claude Code reads the answer file and continues

## Design Decisions

### Playwright over Browser Extension
**Decision: Use Playwright with launchServer**
- Eliminates browser extension, native messaging host, manifests
- ~100 lines vs ~500+ lines
- Single dependency (playwright) vs multiple
- Trade-off: Chromium-only (no Firefox)

### Persistent Profile
**Decision: Dedicated user-data-dir**
- Log into ChatGPT once, stays logged in
- Separate from user's normal Chrome profile
- Avoids Chrome 136+ remote debugging restrictions

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
│   ├── server.js      # Browser server daemon
│   ├── cgpt.js        # CLI tool
│   ├── chatgpt.js     # ChatGPT DOM automation
│   └── session.js     # Claude session discovery
├── package.json
└── .gitignore
```

## Reliability Considerations

### Robust (Low Maintenance)
- Playwright connection to browser server
- File I/O and clipboard
- Session discovery from runtime files
- HTTP POST to Claude-Code-Remote

### Fragile (Requires Maintenance)
- ChatGPT DOM selectors (composer, send button, message container)
- Completion detection heuristics
- Message extraction

**Mitigation:**
- Use semantic selectors where possible
- Multiple completion heuristics (OR logic)
- Clear error messages when selectors fail
- Configurable timeouts

## Technology Choices

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Browser automation | Playwright | Native protocol, persistent context support |
| CLI | Node.js | Matches server, single runtime |
| Browser | Chromium (bundled) | Playwright controls version, consistent behavior |

## Security Considerations

- Browser server binds to localhost only
- WebSocket endpoint is local-only
- Persistent profile in user-writable directory
- No credentials stored (ChatGPT session cookies in profile)

## Limitations

- **Chromium only** - No Firefox support (acceptable trade-off for simplicity)
- **Dedicated browser** - Not your normal Chrome; separate Chromium instance
- **DOM fragility** - ChatGPT UI changes will break selectors (accepted)

## Future Enhancements

- Support for other research tools (Perplexity, Claude.ai web)
- Response streaming (show progress)
- Conversation threading (continue existing chat)
- Multiple concurrent requests
