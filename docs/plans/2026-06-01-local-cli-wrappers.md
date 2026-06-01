# Local CLI Wrappers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `ask-question`, `ask-question-server`, and `ask-question-login` available as local commands inside this repo's `devenv` shell.

**Architecture:** Add `devenv` scripts that wrap the existing Node entry points instead of relying on `npm link`. The scripts use `DEVENV_ROOT` so they work from any working directory inside the activated project environment.

**Tech Stack:** `devenv.nix`, Node.js 22, existing `src/*.js` CLI entry points.

---

### Task 1: Add local CLI wrappers

**Files:**
- Modify: `devenv.nix`

**Step 1: Verify current failure**

Run: `ask-question-login`

Expected: `command not found`

**Step 2: Add `devenv` scripts**

Add scripts for:
- `ask-question` -> `node "$DEVENV_ROOT/src/cli.js" "$@"`
- `ask-question-server` -> `node "$DEVENV_ROOT/src/server.js" "$@"`
- `ask-question-login` -> `node "$DEVENV_ROOT/src/login.js" "$@"`

**Step 3: Verify wrappers are available**

Run: `devenv shell command -v ask-question-login`

Expected: prints a path to the `devenv` script wrapper.

**Step 4: Verify existing tests**

Run: `npm test`

Expected: all tests pass.
