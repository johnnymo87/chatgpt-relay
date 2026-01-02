# ChatGPT Relay

CLI tool that sends prompts to ChatGPT via Playwright browser automation.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Link CLI commands globally
npm link

# 3. First-time login (opens browser)
ask-question-login

# 4. Start the daemon (runs headless)
ask-question-server

# 5. Send a prompt
ask-question "What is the capital of France?"
```

## Commands

| Command | Description |
|---------|-------------|
| `ask-question` | Send prompt to ChatGPT, get response |
| `ask-question-server` | HTTP daemon that manages browser |
| `ask-question-login` | One-time login helper (headed browser) |

## Documentation

- [Architecture](docs/architecture.md) - System design and data flow
- [Implementation Plan](docs/plans/2026-01-01-chatgpt-relay.md) - Development history

## Skills

- [Using ask-question CLI](.claude/skills/using-ask-question-cli/SKILL.md) - Full usage guide

## Integration with /ask-question

This CLI is designed to be invoked by the `/ask-question` slash command in Claude Code. The command:
1. Drafts a Stack Exchange-formatted question
2. Invokes `ask-question -f question.md -o answer.md`
3. Reads the answer and discusses it

Use `/ask-question draft topic` to skip the ChatGPT automation.
