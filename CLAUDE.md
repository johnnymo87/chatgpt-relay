# ChatGPT Relay

CLI tool that sends prompts to ChatGPT via Playwright browser automation.

## Quick Start

```bash
npm install && npm link
ask-question-login                                            # One-time: log into ChatGPT
ask-question-server 2>&1 | tee ~/.chatgpt-relay/daemon.log    # Keep running
ask-question "Hello?"                                         # From another terminal
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
