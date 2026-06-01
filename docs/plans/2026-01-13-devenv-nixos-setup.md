# Devenv Setup for NixOS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Configure devenv for chatgpt-relay so it works on NixOS (ARM64) devbox with Nix-provided Playwright browsers.

**Architecture:** Use `playwright-driver.browsers` from nixpkgs with `PLAYWRIGHT_BROWSERS_PATH` env var. Update npm Playwright to match nixpkgs version (1.56.x). Add conditional `executablePath` in code for Nix environments.

**Tech Stack:** devenv.sh, Nix, Node.js 22, Playwright 1.56.x, nixpkgs playwright-driver

---

## Task 1: Create devenv configuration files

**Files:**
- Create: `devenv.yaml`
- Create: `devenv.nix`
- Create: `.envrc`

**Step 1: Create devenv.yaml**

```yaml
inputs:
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
```

**Step 2: Create devenv.nix**

```nix
{ pkgs, ... }:

let
  pwBrowsers = pkgs.playwright-driver.browsers;
in
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
  };

  # Python needed for node-gyp (Playwright has native deps)
  packages = [ pkgs.python3 ];

  env = {
    # Make Playwright look in the Nix store instead of ~/.cache/ms-playwright
    PLAYWRIGHT_BROWSERS_PATH = "${pwBrowsers}";

    # Don't let npm install auto-download browsers
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

    # Skip host validation on NixOS
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  };

  dotenv.enable = true;

  enterShell = ''
    echo "chatgpt-relay - Node $(node --version)"
    echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
  '';
}
```

**Step 3: Create .envrc**

```bash
if ! has devenv; then
  echo "devenv not found. Install: https://devenv.sh/getting-started/"
  exit 1
fi
eval "$(devenv direnvrc)"
use devenv
```

**Step 4: Verify files created**

Run: `ls -la devenv.yaml devenv.nix .envrc`
Expected: All three files listed

**Step 5: Commit**

```bash
git add devenv.yaml devenv.nix .envrc
git commit -m "$(cat <<'EOF'
Add devenv configuration for NixOS

Configure devenv with:
- Node.js 22 via nixpkgs
- playwright-driver.browsers for Nix-provided Chromium
- Environment variables to skip browser download
- Python 3 for node-gyp native deps

This enables the project to run on NixOS where Playwright's
downloaded browsers don't work due to missing FHS paths.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update .gitignore for devenv

**Files:**
- Modify: `.gitignore`

**Step 1: Add devenv entries to .gitignore**

Append to `.gitignore`:
```
# Devenv
.devenv/
.devenv.flake.nix
```

**Step 2: Verify .gitignore contents**

Run: `cat .gitignore`
Expected: Contains `.devenv/` and `.devenv.flake.nix` at the end

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "$(cat <<'EOF'
Add devenv files to .gitignore

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update Playwright version to match nixpkgs

**Files:**
- Modify: `package.json`

**Step 1: Update package.json playwright version**

Change `"playwright": "^1.40.0"` to `"playwright": "^1.56.0"`:

```json
{
  "dependencies": {
    "playwright": "^1.56.0",
    "undici": "^7.18.2"
  }
}
```

**Step 2: Verify package.json change**

Run: `grep playwright package.json`
Expected: `"playwright": "^1.56.0"`

**Step 3: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
Upgrade Playwright to 1.56.x for nixpkgs compatibility

The nixpkgs playwright-driver is version 1.56.1. Playwright's
browser revision must match between npm package and Nix-provided
browsers, so we upgrade to align versions.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add executablePath support to browser launch

**Files:**
- Modify: `src/server.js:157-165`
- Modify: `src/login.js:29-34`

**Step 1: Update server.js chromium.launch()**

In `src/server.js`, update the `chromium.launch()` call (around line 157) to include conditional `executablePath`:

Before:
```javascript
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });
```

After:
```javascript
  // Support Nix-provided Chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  if (executablePath) {
    console.log(`[ask-question-server] Using Chromium: ${executablePath}`);
  }

  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });
```

**Step 2: Update login.js chromium.launch()**

In `src/login.js`, update the `chromium.launch()` call (around line 29) similarly:

Before:
```javascript
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });
```

After:
```javascript
  // Support Nix-provided Chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  if (executablePath) {
    console.log(`[ask-question-login] Using Chromium: ${executablePath}`);
  }

  const browser = await chromium.launch({
    headless: false,
    executablePath,
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });
```

**Step 3: Verify changes**

Run: `grep -n executablePath src/server.js src/login.js`
Expected: Both files show executablePath usage

**Step 4: Commit**

```bash
git add src/server.js src/login.js
git commit -m "$(cat <<'EOF'
Support Nix-provided Chromium via executablePath

Add PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH env var support to both
server and login scripts. When set, Playwright uses the specified
Chromium binary instead of downloading its own.

This enables running on NixOS where Playwright's bundled browsers
fail due to missing FHS-style library paths.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update devenv.nix to set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

**Files:**
- Modify: `devenv.nix`

**Step 1: Add chromium executable path extraction**

Update `devenv.nix` to compute and export the chromium executable path:

```nix
{ pkgs, ... }:

let
  pwBrowsers = pkgs.playwright-driver.browsers;

  # Read the chromium revision from playwright-driver's browsers.json
  browsersJson = builtins.fromJSON (builtins.readFile "${pkgs.playwright-driver}/browsers.json");
  chromiumEntry = builtins.head (builtins.filter (b: b.name == "chromium") browsersJson.browsers);
  chromiumRev = chromiumEntry.revision;

  # Construct path to chromium executable
  # On ARM64 Linux: chromium-XXXX/chrome-linux/chrome
  chromiumExe = "${pwBrowsers}/chromium-${chromiumRev}/chrome-linux/chrome";
in
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
  };

  # Python needed for node-gyp (Playwright has native deps)
  packages = [ pkgs.python3 ];

  env = {
    # Make Playwright look in the Nix store instead of ~/.cache/ms-playwright
    PLAYWRIGHT_BROWSERS_PATH = "${pwBrowsers}";

    # Don't let npm install auto-download browsers
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

    # Skip host validation on NixOS
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";

    # Direct path to Nix-provided Chromium executable
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = chromiumExe;
  };

  dotenv.enable = true;

  enterShell = ''
    echo "chatgpt-relay - Node $(node --version)"
    echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
    echo "Chromium: $PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
  '';
}
```

**Step 2: Verify devenv.nix syntax**

Run: `nix-instantiate --parse devenv.nix > /dev/null && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
git add devenv.nix
git commit -m "$(cat <<'EOF'
Add chromium executable path to devenv.nix

Extract the chromium revision from playwright-driver's browsers.json
and construct PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for use by the
server and login scripts.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Merge architecture docs into using-ask-question-cli skill

**Files:**
- Modify: `.claude/skills/using-ask-question-cli/SKILL.md`
- Delete: `docs/architecture.md`

**Step 1: Append architecture content to skill**

Add the essential architecture content from `docs/architecture.md` to the end of `.claude/skills/using-ask-question-cli/SKILL.md`:

```markdown
## Architecture Deep Dive

### Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                            │
│      │                                                                  │
│      ▼                                                                  │
│  /ask-question (slash command)                                          │
│      │                                                                  │
│      ▼                                                                  │
│  CLI (ask-question) ─► HTTP POST /ask ─► ask-question-server (daemon)   │
│                                               │                         │
│                                               ▼                         │
│                                         Chromium (headless)             │
│                                         + storageState session          │
│                                               │                         │
│                                               ▼                         │
│                                         ChatGPT tab                     │
│                                         (DOM automation)                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Design Decisions

**HTTP Daemon over WebSocket Connect**
- `launchServer()` doesn't support persistent sessions
- HTTP is curl-debuggable and simpler
- Request queue handles serialization naturally
- Browser runs headless (no focus-stealing)

**Headless with StorageState**
- `ask-question-login`: One-time headed browser for manual login, saves cookies
- `ask-question-server`: Headless browser loads saved session
- Session persists across server restarts

### Reliability Features

| Feature | Description |
|---------|-------------|
| Request ID Tracing | 8-char ID correlates CLI and server logs |
| Automatic Retry | CLI retries once on connection failures |
| Network Failure Detection | Tracks streaming response via `response.finished()` |
| Hard Reset on Errors | Closes and recreates page on failure |
| Login Verification | Server verifies login state at startup |

### Fragile Components (Maintenance Required)

These rely on ChatGPT's DOM structure and may break when ChatGPT updates their UI:

- Composer selectors (`div[contenteditable]`, `#prompt-textarea`)
- Send button selectors (`button[data-testid="send-button"]`)
- Message extraction (copy button, innerText fallback)
- Login detection (chat history panel visibility)
- Stop button lifecycle (generation progress)

**Mitigation:** Multiple selector fallbacks, semantic selectors where possible, clear error messages.
```

**Step 2: Delete docs/architecture.md**

Run: `git rm docs/architecture.md`

**Step 3: Verify skill file updated**

Run: `grep -c "Architecture Deep Dive" .claude/skills/using-ask-question-cli/SKILL.md`
Expected: `1`

**Step 4: Commit**

```bash
git add .claude/skills/using-ask-question-cli/SKILL.md
git commit -m "$(cat <<'EOF'
Consolidate architecture docs into CLI skill

Move essential architecture content from docs/architecture.md into
the using-ask-question-cli skill. This follows the pattern of keeping
Claude-facing docs in .claude/skills/ rather than scattered in docs/.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Clean up TODO file

**Files:**
- Delete: `TODO-devenv-setup.md`

**Step 1: Remove TODO file**

Run: `git rm TODO-devenv-setup.md`

**Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
Remove completed TODO-devenv-setup.md

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Test on devbox

**Files:** None (testing only)

**Step 1: Push changes to remote**

```bash
git push origin main
```

**Step 2: SSH to devbox and test devenv**

```bash
ssh devbox "cd ~/Code/chatgpt-relay && git pull && direnv allow && node --version"
```

Expected: Node version v22.x printed

**Step 3: Verify Playwright env vars**

```bash
ssh devbox "cd ~/Code/chatgpt-relay && echo \$PLAYWRIGHT_BROWSERS_PATH && echo \$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
```

Expected: Two Nix store paths printed

**Step 4: Install npm dependencies**

```bash
ssh devbox "cd ~/Code/chatgpt-relay && npm install"
```

Expected: Install completes without downloading Playwright browsers

**Step 5: Verify chromium executable exists**

```bash
ssh devbox 'test -x "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" && echo "Chromium OK" || echo "Chromium NOT FOUND"'
```

Expected: `Chromium OK`

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Create devenv.yaml, devenv.nix, .envrc |
| 2 | Update .gitignore for devenv files |
| 3 | Upgrade Playwright to 1.56.x |
| 4 | Add executablePath support to browser launch |
| 5 | Update devenv.nix with chromium path extraction |
| 6 | Merge architecture docs into skill |
| 7 | Remove TODO file |
| 8 | Test on devbox |
