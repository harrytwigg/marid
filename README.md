<h1 align="center">Marid</h1>

<p align="center"><b>Run your AI agents as a company.</b></p>

<p align="center">
  Marid turns the agent CLIs you already use - Claude Code, Codex, Grok, Hermes, opencode - into a persistent AI company:
  named employees and a durable Todo ledger,
  all operated from a chat and web dashboard.<br/>
  It doesn't replace your agents. <b>It gives them an org to work in.</b>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1E7A8C" alt="license: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-1E7A8C" alt="node 22 or newer" />
  <img src="https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white" alt="Docker supported" />
  <img src="https://img.shields.io/badge/status-beta-1E7A8C" alt="status: beta" />
</p>

> **You bring the engines. Marid runs the company.**

## Built on Jinn

Marid is a fork of [Jinn](https://github.com/hristo2612/jinn) by hristo2612 and contributors (MIT). Most of the code here is theirs: the gateway, the org, Todos, the web dashboard and the engine adapters. Marid keeps tracking upstream and adds features on top of it - see [What Marid adds](#what-marid-adds). The original copyright is preserved in [LICENSE](LICENSE) and the credit is repeated in [NOTICE](NOTICE).

Internally the codename stays "Jinn": the `jinn` command, the `jinn-cli` package name, `~/.jinn` and the `JINN_*` variables are unchanged, so an existing Jinn install keeps working and upstream fixes merge cleanly.

> The `npm install -g jinn-cli` and Homebrew installs below ship the **upstream** Jinn package, not Marid. To run Marid's features, [build from this repository](#development).

---

## Why Marid?

Agent CLIs are powerful alone. Marid gives them shared structure, ownership, and history.

- **🎼 Bus, not brain.** Marid conducts the agent CLIs on your `PATH` and adds no AI logic. Better engines make Marid better automatically.
- **🏢 A real org.** Define named employees, ranks, departments, and reporting lines in YAML. Your COO delegates through the hierarchy.
- **📋 Durable work.** Todos preserve ownership and review beyond a session; the built-in MCP gives employees typed company tools.
- **⏰ Work with receipts.** Cron, delegation, and callbacks keep running and leave structured activity in Chat.

> Marid is **beta**. It works today and moves fast; read the upgrade notes when you bump versions.

---

## What Marid adds

Everything in upstream Jinn still applies. On top of it, Marid adds:

| Area | Marid | Jinn upstream |
|---|---|---|
| Workspace | VS Code-style split panes you can resize, per-pane tabs with preview and pinned tabs, drag a chat from the sidebar to split, mobile session tabs, teal theme | auto-arranged chat grid, single tab list, no resizing |
| Terminal / CLI mode | type straight into the engine's TUI (stdin, paste, mouse, scroll); standalone shells on the gateway or a remote host in the sidebar | display-only CLI view with a composer and key bar |
| opencode | opencode engine, server mode with a live terminal, usage metering | not supported |
| Remote hosts | Claude, Pi and opencode employees run over SSH on another machine | not supported |
| Remote MCP connector | use your instance as a custom connector in claude.ai, Claude Desktop and Claude Code (opt-in) | not supported |
| Sessions | self-compaction (`compact_session`), engine-aware `/compact`, opt-in auto-compaction of long sessions (cache-cold, or past a context budget), fuller restart resume, Claude auth outage handling | Claude-only `/compact`, basic restart resume |
| Todos and dispatch | closed departments, a default board walk that releases gated Todos and starts work on spare capacity, with an Auto-Dispatch page, per-Todo auto-start opt-out, session tree per Todo | open departments, no board walk |

The full feature-by-feature table, with what upstream already has, is in [`docs/marid-vs-jinn.md`](docs/marid-vs-jinn.md).

---

## Quickstart

### Native install

> **Prerequisites:** Node.js **22 or newer** (the repository pins **24.13.0** in `.nvmrc`), and at least one agent CLI installed **and signed in**. Marid orchestrates your engines and can't run a session without one.

```bash
# 1. Install (upstream Jinn package - see "Built on Jinn" above)
npm install -g jinn-cli

# 2. Install + sign in to at least one engine (example: Claude Code)
npm install -g @anthropic-ai/claude-code
claude            # run once, use /login, then quit

# 3. Set up ~/.jinn (probes your engines, writes config, seeds your company)
jinn setup

# 4. Start the gateway - opens the dashboard for you
jinn start
```

Open **[http://localhost:7777](http://localhost:7777)** and send your first message.

Or install via **Homebrew**:

```bash
brew tap hristo2612/jinn https://github.com/hristo2612/jinn
brew install jinn
jinn setup && jinn start
```

> **`--version` ≠ signed in.** Marid drives the official engine CLIs, so authenticate each one *before* `jinn start` (run `claude` → `/login`, run `codex` to sign in, and so on). Without this, sessions can't reach the models - the most common fresh-install gotcha.

### Docker

Docker needs Docker Engine or Docker Desktop with Compose v2, but it does **not** need Node.js or an agent CLI installed on the host. The image includes Claude Code. Containerising bounds the engine's permission-free access to the directories you explicitly mount instead of your whole home directory:

```bash
git clone https://github.com/harrytwigg/marid.git
cd marid

# Edit docker-compose.yml and uncomment at least one "Project mounts" entry.
# Without one, /work is empty and the agents have nothing to work on.
docker compose up -d --build
docker compose exec jinn claude     # run once, use /login, then quit
docker compose exec jinn jinn pair  # prints a code for the browser
```

Then open **[http://localhost:7777](http://localhost:7777)** and enter the code at the pairing prompt. The gateway binds `0.0.0.0` inside the container, so it requires auth, and your browser reaches it through Docker's NAT rather than loopback — which is why pairing replaces the automatic sign-in a host install gets.

The compose image runs one instance. Additional instances need separate containers, dedicated Marid/Claude volumes and separately published ports. The writable blast radius includes those state volumes (OAuth, sessions and plugins), every writable project mount, and unrestricted network egress; see the Docker guide before mounting sensitive data.

The image ships the `claude` engine only. `codex`, `grok` and `hermes` are not included, and neither are `ffmpeg`/`whisper-cli` for speech-to-text — the same as a Homebrew or npm install, which leave those to you. See **[docs/docker.md](docs/docker.md)** for the mount model, what persists across upgrades, how to add speech-to-text, and what the isolation does and does not cover.

Everyday commands for a native install:

```bash
jinn start      # start the gateway daemon (auto-opens the dashboard)
jinn stop       # stop it
jinn restart    # restart safely (detached; works even from inside a session)
jinn status     # is the daemon running?
```

Docker owns the gateway lifecycle instead — `jinn start`, `jinn stop`, and `jinn restart` are intentionally unavailable inside the container:

```bash
docker compose ps                 # status and health
docker compose logs -f jinn       # follow gateway logs
docker compose restart jinn       # restart safely
docker compose down               # stop; named volumes remain intact
```

After upgrading, the gateway re-syncs the skills Marid ships on every boot; `jinn migrate` does the same on demand and prints what changed. An edit to a shipped skill is replaced then (the previous copy is kept in a backup), so customize by writing a skill of your own. An upgrade does not touch skills you wrote, your `CLAUDE.md`, `docs/`, `knowledge/` or `org/`, so to pick up new stock content, compare them with `packages/jinn/template/`.

---

## The company model

Marid exposes a small set of building blocks and handles the machinery underneath. The screenshots below are from upstream Jinn's dashboard.

**Employees** are editable YAML roles with a name, department, rank, and engine. One employee can run several sessions; different roles can use different engines.

**Todos** are the durable work ledger. They track assignee, priority, status, sub-tasks, discussion, approvals, and reviewer-owned completion across sessions.

<div align="center">
  <img src="assets/todos.png" alt="The Todos ledger - tickets assigned to AI employees across To do, in-progress, review, and done" width="880" />
</div>

**Chat** operates the company. Delegations, callbacks, and Todo changes appear beside the conversation as durable activity receipts.

<div align="center">
  <img src="assets/chat.png" alt="Chat (upstream Jinn UI) - an engineering employee diagnosing and fixing a flaky test, with company activity receipts" width="880" />
</div>
<div align="center"><sub>An Engineering employee triages a flaky test, ships the fix, and opens a PR, with each delegation and callback rendered as an activity receipt.</sub></div>

**Notes** are durable Markdown knowledge: plain `.md` files under `~/.jinn/knowledge/`, in folders of your choosing. Typed tools read and write them, and every update carries the revision it expects, so two sessions cannot silently overwrite each other.

**Heartbeats** are recurring self-wakes a session schedules for itself. A message is redelivered into the owning session on a fixed interval until the session stops it, or a fire limit or expiry disarms it.

**Plugins** extend the app itself: an enabled directory under `~/.jinn/plugins/` adds dashboard pages, sidebar rows, and status chips, and may also mount gateway HTTP routes and a supervised background task, with no build step. See [`docs/plugins.md`](docs/plugins.md) for the manifest, the SDK surface, and the security posture.

**Skills and Cron** provide reusable playbooks and scheduled work. A built-in **MCP server** (`jinn`) gives engines typed tools for company operations; shell access remains available for local implementation.

---

## How it works

Marid is a local gateway daemon plus a web dashboard. It dispatches work to installed engines, persists company state, runs automation, and serves the UI at `localhost:7777`.

```
                          +----------------+
                          |    jinn CLI    |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |    Gateway     |
                          |     Daemon     |
                          +--+--+--+--+----+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                 |
      +-------v---------+ +-----v------+  +---------v-----+
      |     Engines     | | Connectors |  |    Web UI     |
      | claude · codex  | | Slack · WA |  | localhost:7777|
      | grok · hermes…  | | Discord·TG |  |               |
      +-------+---------+ +-----+------+  +-------+-------+
              |                                   |
      +-------v-------+   +-----------+   +--------v-------+
      |     Todos     |   |   Cron    |   |  MCP server    |
      |               |   | Scheduler |   |  company hands |
      +---------------+   +-----------+   +----------------+
```

Claude runs in a real interactive terminal, so eligible turns bill against a Max/Pro subscription. Other engines use spawn-per-turn or streaming models. Marid discovers supported models from each CLI when available.

---

## The org system

Employees live in `~/.jinn/org/` as plain YAML:

```yaml
name: research-lead
displayName: Research Lead
department: research
rank: manager
engine: claude
model: opus
reportsTo: chief-of-staff      # hierarchy of any depth
persona: |
  You lead market research. Break briefs into parallel sub-tasks,
  delegate to your analysts, and synthesize one clear answer.
```

Ranks set default reporting lines; `reportsTo` overrides them at any depth. Managers delegate sub-tasks as Todos and roll results back up, while any employee remains directly reachable.

Reviewers choose TRUST, VERIFY, or THOROUGH oversight. Money, irreversible or public actions, and legal or security risk route to you.

<div align="center">
  <img src="assets/org-map.png" alt="Interactive org chart of AI employees across departments" width="900" />
</div>

---

## Engines - bring your own

Marid detects installed agent CLIs and lets each employee or session choose an engine. It discovers model catalogs when supported and otherwise uses labels from `config.yaml`.

| Engine | What it is | Install | Modes | Effort |
|--------|-----------|---------|-------|--------|
| **claude** | Anthropic Claude Code - first-party, subscription-friendly | `npm install -g @anthropic-ai/claude-code` | Chat (PTY + live stream) · CLI (xterm) | low / medium / high |
| **codex** | OpenAI Codex CLI | `npm install -g @openai/codex` | Chat · CLI (xterm) | low / medium / high / xhigh |
| **grok** | xAI Grok CLI | `npm install -g @xai-official/grok` (run `grok` once to auth) | Chat · CLI (xterm) | low / medium / high / xhigh / max |
| **antigravity** | Antigravity CLI (`agy`) | see Antigravity docs | CLI (xterm) | - |
| **pi** | Pi coding agent CLI | see Pi CLI docs | Chat | - |
| **opencode** | [opencode](https://opencode.ai) - open-source terminal coding agent, bring your own provider | `curl -fsSL https://opencode.ai/install \| bash` (then `opencode auth login`) | Chat (batch, or server mode with a live terminal) | - |
| **hermes** | NousResearch Hermes - open-source, model-agnostic agent | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | Chat (ACP streaming) · CLI (xterm view) | - |

Fallback labels include **Opus (Latest)**, **Sonnet (Latest)**, **Fable (Latest)**, **GPT-5.5 Codex**, **Grok Build**, and **Gemini 3.5 Flash Medium / High / Low**. Pi and Hermes report their models at session start.

> **Hermes cost note.** Unlike the subscription-wrapped engines, Hermes owns its own model loop and bills **per token** on the provider configured in `~/.hermes`. It streams over the Agent Client Protocol (ACP) and runs fully auto-approved. See [`docs/engines-hermes.md`](docs/engines-hermes.md).

<details>
<summary><b>How the Claude engine runs on your subscription</b> (the PTY details)</summary>

Marid drives the interactive `claude` binary through [node-pty](https://github.com/microsoft/node-pty), so eligible turns use Max/Pro subscription billing. Hooks mark turn boundaries, a loopback proxy streams model output, and transcript JSONL provides token usage.

The Chat and CLI views share one PTY. Terminal snapshots survive reconnects and gateway restarts. Codex, Grok, and Pi spawn per turn; Hermes streams over ACP.

</details>

---

## What people build with it

- **Shipping Slack bots** that delegate work and report back in-thread.
- **Content pipelines** that research, draft, review, and publish on schedule.
- **Support desks** that require human approval before sending replies.
- **Research orgs** where managers fan out questions and synthesize the results.
- **Ops runbooks** encoded as scheduled cron jobs and Todos with approvals and durable history.

---

## Configuration

Marid reads `~/.jinn/config.yaml`. A fresh setup includes this core shape:

```yaml
gateway:
  port: 7777
  host: "127.0.0.1"
  authRequired: true
  notesEnabled: false

engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
    fallback: [codex, grok]
  codex:
    bin: codex
    model: gpt-5.5
  grok:
    bin: grok
    model: grok-build
  hermes:
    bin: hermes
    model: openai-codex:gpt-5.5

models:
  claude:
    default: opus
    effortMechanism: claude-flag
    models:
      - { id: opus, label: "Opus (Latest)", supportsEffort: true, effortLevels: [low, medium, high, xhigh, max] }

logging:
  file: true
  stdout: true
  level: info
```

- **Engines** select CLI binaries and defaults; `engines.default` controls new sessions.
- **Fallback chains** — `engines.<name>.fallback` names the engines to try, in order of preference, when that one cannot serve a turn. Two engines may name each other; an engine may not name itself.
- **`sessions.rateLimitStrategy` and `sessions.fallbackEngine` are deprecated** in favour of `engines.claude.fallback`. They still work: the loader maps them forward and warns once.
- **Auto-compaction** — `engines.claude.autoCompact` and `engines.opencode.autoCompact` (`enabled`, default `false`; `cacheWindowSeconds`, default `300`; `minContextTokens`, default `100000`; `maxContextTokens`, no default) compact a long, cache-cold session before its next turn, and, with `maxContextTokens` set, any session whose context has reached that budget. See [`docs/auto-compaction.md`](docs/auto-compaction.md).
- **Todo board reminder** — every turn of a session with the built-in company tools ends with one fixed line restating the Todo status procedure, so it survives long and compacted conversations. It is 60 tokens, and each turn's copy stays in the engine's history, so a session of N turns carries about 60×N tokens of it until it compacts. It is added when the engine is called, never to the stored message, and never after a slash command. `context.boardReminder` replaces the text (`{{default}}` stands for the built-in line, to extend it); `false` turns it off.
- **Models** form an extensible per-engine capability registry. CLI discovery can replace fallback entries at runtime.
- **MCP servers** are optional; enable `mcp.gateway` for the built-in company tools.
- **Cron, employees, and skills** live in `~/.jinn/cron/jobs.json`, `~/.jinn/org/`, and `~/.jinn/skills/`.
- **Plugins** live in `~/.jinn/plugins/` and only run when `plugins.enabled` names them; see [`docs/plugins.md`](docs/plugins.md) for the anatomy, lifecycle, and security posture.
- **Behind a reverse proxy or tunnel**, the proxy must preserve `Host`, or pass the host the browser dialled in `X-Forwarded-Host`. The gateway's WebSockets (the live event stream `/ws`, plugin event sockets and terminals) refuse a browser whose `Origin` is not the gateway's own host, so a proxy that rewrites `Host` and forwards neither leaves the dashboard without live updates. A Cloudflare tunnel's default ingress preserves `Host`; don't set `httpHostHeader` on it.

Everything is human-readable and yours to edit. After upgrading, the gateway re-syncs the skills Marid ships on boot (see the upgrade note under Quickstart). An edit to a shipped skill is replaced then, with the previous copy kept in a backup, so customize by writing a skill of your own. Skills you wrote, `CLAUDE.md`, `docs/`, `knowledge/` and `org/` are left as they are.

---

## Roadmap

Marid is in active beta. Shipped recently in upstream Jinn:

- **Collaborative Todo hierarchy** with sub-tasks, roll-up gates, labels, comments, links, attachments, provenance, and approval history.
- **Isolated workspaces** with separate homes, ports, access settings, and authentication.
- **Grouped Todo receipts**, model-scoped Claude limits, instance-wide MCP file reads, and authentication required by default.

On deck:

- **Engines:** local models.
- **Connectors:** iMessage and email.
- **Platform:** multi-user roles.

See [CHANGELOG.md](CHANGELOG.md) for release history.

---

## Development

Marid is a pnpm + turbo monorepo.

```bash
git clone https://github.com/harrytwigg/marid.git
cd marid
pnpm install
pnpm setup   # one-time: builds all packages and creates ~/.jinn
pnpm dev     # gateway (:7777) + Vite dev server (:5173) with hot reload
```

Open **[http://localhost:5173](http://localhost:5173)**. Vite proxies `/api` and `/ws` to the gateway.

```bash
pnpm build       # build every package (turbo) and sync web assets
pnpm test        # run the test suites across packages
pnpm typecheck   # type-check without emitting
pnpm lint        # lint every package
pnpm test:e2e    # Playwright end-to-end tests
```

> **Prerequisites:** Node.js **22 or newer**; contributors should use **24.13.0**, pinned by `.nvmrc` + `engine-strict` because native modules like `better-sqlite3` are ABI-locked. You also need pnpm **10.6+** and at least one engine CLI. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the full setup.

---

## License

[MIT](LICENSE). Copyright (c) 2026 Jinn Contributors, and (c) 2026 Marid contributors for the changes made in this fork. See [NOTICE](NOTICE) for attribution.

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for setup and pull request instructions.
