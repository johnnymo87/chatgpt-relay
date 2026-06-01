# ChatGPT Relay

CLI tool that sends prompts to ChatGPT via Playwright browser automation.

## Quick Start

```bash
npm install
ask-question-login       # One-time: log into ChatGPT
npm run server:log       # Keep running (logs to ~/.local/state/chatgpt-relay/daemon.log)
ask-question "Hello?"    # From another terminal
```

This repo uses `devenv`/`direnv` to expose the local `ask-question*` commands.
Do not use `npm link`; Nix npm prefixes may be read-only. If the shell is not
activated, prefix commands with `devenv shell --`, for example:

```bash
devenv shell -- ask-question-login
```

## Commands

| Command | Description |
|---------|-------------|
| `ask-question` | Send prompt to ChatGPT, get response |
| `ask-question-server` | HTTP daemon that manages browser |
| `ask-question-login` | One-time login helper (headed browser) |

## Skills

| Skill | Description |
|-------|-------------|
| [Using ask-question CLI](.claude/skills/using-ask-question-cli/SKILL.md) | Full usage, troubleshooting, architecture |

## Plans

| Plan | Description |
|------|-------------|
| [Initial Implementation](docs/plans/2026-01-01-chatgpt-relay.md) | Original development |
| [Copy Button Extraction](docs/plans/2026-01-11-copy-button-extraction.md) | Response extraction improvement |
| [Devenv NixOS Setup](docs/plans/2026-01-13-devenv-nixos-setup.md) | NixOS/devenv configuration |
| [Local CLI Wrappers](docs/plans/2026-06-01-local-cli-wrappers.md) | Local `devenv` command wrappers |
