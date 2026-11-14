# 🧞 Hundredfold

> Run your AI agents as a company. Hundredfold is a bus, not a brain.

[![npm version](https://img.shields.io/npm/v/hundredfold.svg)](https://www.npmjs.com/package/hundredfold)
[![license: MIT](https://img.shields.io/npm/l/hundredfold.svg)](https://github.com/hundredfoldhq/hundredfold)
[![node](https://img.shields.io/node/v/hundredfold.svg)](https://github.com/hundredfoldhq/hundredfold)

<p align="center">
  <img src="https://raw.githubusercontent.com/hundredfoldhq/hundredfold/main/assets/chat.png" alt="Hundredfold web dashboard" width="800" />
</p>

Hundredfold turns installed agent CLIs into a persistent AI company: named employees, a Todo ledger, reusable Workflows, and one chat and dashboard. It delegates to the official CLIs instead of replacing them.

## Engines

Mix the eight shipped engines. Hundredfold hides unavailable binaries and lets each employee or session choose one:

- **claude** - Anthropic Claude Code
- **codex** - OpenAI Codex CLI
- **grok** - xAI Grok CLI
- **antigravity** - Antigravity CLI (`agy`)
- **pi** - Pi coding agent
- **opencode** - opencode, bring your own provider
- **hermes** - NousResearch Hermes over ACP
- **musecode** - Meta Muse Code over its session protocol

## Quickstart

> **Prerequisites:** Node.js **22 or newer** (the repository pins **24.13.0** in `.nvmrc`), and at least one agent CLI installed **and signed in**.

```bash
# 1. Install Hundredfold
npm install -g hundredfold

# 2. Install + sign in to at least one engine (example: Claude Code)
npm install -g @anthropic-ai/claude-code
claude            # run once, use /login, then quit

# 3. Set up ~/.hundredfold (probes your engines, writes config, seeds your company)
hundredfold setup

# 4. Start the gateway - opens the dashboard for you
hundredfold start
```

Or install via Homebrew:

```bash
brew tap hundredfoldhq/hundredfold https://github.com/hundredfoldhq/hundredfold
brew install hundredfold
hundredfold setup && hundredfold start
```

Then open [http://localhost:7777](http://localhost:7777).

## Company building blocks

- **Employees** are YAML roles with personas, departments, ranks, reporting lines, and engine defaults.
- **Todos** preserve assignment, priority, status, sub-tasks, labels, comments, links, attachments, approvals, and reviewer-owned completion across sessions.
- **Workflows** combine sequential, conditional, parallel, and switch paths, per-node engines and models, native approvals, schema-validated completion, evidence, and durable run history.
- **Hundredfold MCP** gives capable engines typed tools for org, sessions, delegation, Todos, Workflows, Triggers, approvals, Notes, cron, connectors, attachments, and managed files.
- **Chat** keeps the receipts. Delegations, callbacks, Todo changes, and Workflow operations render as structured activity beside the conversation.
- **Skills, Notes, Cron, and connectors** provide reusable playbooks, durable knowledge, scheduled work, and external communication.

## How it runs

One local gateway dispatches work, persists company state, and serves the dashboard. Claude runs through its interactive CLI inside a PTY, so eligible turns use your subscription. Hermes is provider-metered; see the [Hermes engine guide](https://github.com/hundredfoldhq/hundredfold/blob/main/docs/engines-hermes.md).

## Documentation

Read the [full README](https://github.com/hundredfoldhq/hundredfold), [changelog](https://github.com/hundredfoldhq/hundredfold/blob/main/CHANGELOG.md), and [contributing guide](https://github.com/hundredfoldhq/hundredfold/blob/main/.github/CONTRIBUTING.md).

## License

[MIT](https://github.com/hundredfoldhq/hundredfold/blob/main/LICENSE)
