# Muse Code Engine

[Muse Code](https://dev.meta.ai) is Meta's terminal coding agent (the `muse` CLI). Marid drives it as a batch engine over Muse's own session protocol: one `muse serve` per turn, JSON-RPC on stdio, no PTY.

> **Metered or subscription.** What a turn costs depends on how Muse is signed in. A Muse subscription has a five-hour window and a weekly block, which the [Limits page](#usage-limits) shows. An API key created outside onboarding bills pay-as-you-go. Check which one you are on before running Muse Code on high-volume work.

---

## Installation

```bash
curl -fsSL https://dev.meta.ai/install.sh | bash
```

Marid only resolves the binary from `PATH` (or `engines.musecode.bin`); every provider decision is the CLI's own. Check what it is:

```bash
muse --version
```

---

## Authentication

Credential precedence is Muse's own: the `META_API_KEY` environment variable, then a stored key, then a browser session.

- **Subscription:** run `muse login` once on the gateway's machine. The login is stored under `~/.config/muse/` and every turn reads it.
- **Pay-as-you-go:** set `META_API_KEY` in the gateway's environment, or store a key with `muse auth set`.

A turn that finds no credentials fails with "Muse Code is not signed in" and the fix above. Marid never reads or writes Muse's credential files.

---

## Configuration

```yaml
engines:
  musecode:
    bin: muse                  # optional: PATH-resolved when absent
    model: muse-spark-1.2      # a catalog id; see Model discovery
    effortLevel: medium        # sent on each turn as reasoningEffort
    fallback: [claude]         # engines to try when Muse Code cannot serve a turn
```

An employee can carry `cliFlags` in its YAML. They are appended to `muse serve` after Marid's own flags, so `cliFlags: ["-c", "run.reminder_roster=[]"]` reaches every turn that employee runs.

**Effort levels** come from the model: `muse-spark` rows list the tiers they accept (`minimal` to `xhigh`), `none` is never offered because the provider rejects it, and a model whose host reports no list gets no effort picker.

---

## Invocation contract

Every turn starts its own host:

```
muse serve --disable-sandbox \
  -c context.foreign_personal_rules=false -c context.foreign_personal_skills=false \
  [--model <id>] [...cliFlags]
```

Marid then speaks the Muse Session Protocol (MSP, JSON-RPC 2.0, one JSON object per line) over its stdio:

1. `initialize`, then the `initialized` notification. Every other method answers `notInitialized` before that.
2. `session/start` (fresh) or `session/resume` (a later turn), with `approvalMode: allowAll`.
3. `turn/start` with the prompt. It answers at once; the turn then runs on its own.
4. The turn ends on **`turn/completed`**, never on `turn/foregroundCompleted`, which is explicitly non-terminal.
5. Marid closes the host's stdin, waits for it to exit, and signals it if it does not.

There is no pool of hosts: a turn owns its process, so nothing leaks between sessions and nothing needs reconciling on a restart.

What the turn streams: `agentMessage` text (the final answer, as `finalAnswer` items), tool calls with their visible output, and one status line per model retry. Reasoning is never shown.

**Prompt.** Marid's system prompt is prefixed to the user input on a fresh session only. Muse's own system and developer prompts are never replaced. `context.foreign_personal_*` stop Muse loading the operator's own `~/.claude` and Codex rules and skills, so an employee's instructions come from Marid and nothing else.

**Approvals.** Sessions run in `allowAll`, so approvals are not asked for. If an `approval/request` arrives anyway it is allowed; a question for the user is declined, because either left unanswered holds the turn open.

### Sessions and resume

Muse assigns the session id (a UUIDv7) and keeps the conversation in its own store under `~/.local/share/muse`. Marid keeps that id as the resume id, and a later turn `session/resume`s it in a new process.

If Muse no longer has the session (`sessionNotFound`), the turn is reported as a dead resume with zero turns and zero cost, so Marid clears the id and starts a fresh conversation. Any other failure after the session exists counts as one turn.

---

## The company toolset (MCP)

Muse takes MCP servers per session, in `session/start` and `session/resume`, so nothing is written to disk. Marid projects the session's resolved servers into `config.mcpServers` (stdio and streamable HTTP). Every server is projected as `optional`, so a session whose company tools fail to start still has its files and shell. The host grants per-session MCP only when asked for the `sessionMcp` capability, which Marid does exactly when the session has servers; if it is not granted the turn runs without the company tools and says so.

---

## Model discovery

Marid asks a short-lived `muse serve` for its catalog (`initialize`, then `model/list`, with a 15-second limit) and kills it. It runs on the background refresh timer, on `POST /api/engines/refresh` and from `jinn limits`. It never throws: a binary that will not start, or a host that does not answer, leaves the offline catalog in place.

A row becomes a model like this:

| Catalog field | Marid |
| --- | --- |
| `modelId`, `displayLabel` | the model's id and label |
| `isDefault` | the registry's default, unless `engines.musecode.model` pins one |
| `variants` (minus `none`) | the effort levels |
| `contextLimit` | the context window |
| `cost` (per-million decimal strings) | the rates a turn is priced at |

The offline fallback is the four documented models: `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2` (the default) and `muse-spark-1.2-contributor`. A pinned model the catalog does not list stays selectable.

Two things about the real host are worth knowing:

- **A host lists models only once its catalog resolves a default.** With no credentials or no reachable catalog, `model/list` answers an empty `bundledCatalog`, and Marid keeps the offline four. Muse caches the last catalog it fetched under its home, so a machine that has been online once keeps listing it.
- **The default is the host's, not the documentation's.** The catalog's `roles` do not decide `isDefault`; the host flags the newest release. Once discovery has run, a new session's default is whatever the host says.

### Turn cost

When the catalog declares a model's rates, a turn's cost is `(input - cached) x input + cached x cached + output x output`, per million tokens. Muse's `turn/completed` carries no `usage`, so Marid sums the turn's `session/tokenUsage` notifications (one per model call). A model with no declared rates, or a turn with no usage, reports **no cost** rather than 0.

---

## Usage limits

### A quota that is spent

A subscription that runs out ends the turn with a typed error carrying `quota` and the reset time. Marid reads that, never the message text, and reports the turn as rate limited until the reset. From there the existing behaviour applies: the session waits for the reset, or moves to the engine's `fallback` chain.

A transient 429 is different. Muse retries in place (up to ten attempts) and reports each as a retry; Marid shows it as a status line ("Muse Code rate limited (HTTP 429); retry 2/10 in 1s") and the turn completes normally.

### The Limits page

Muse reports subscription usage as `usage/changed` during a turn: the plan tier, a window (five hours) and a weekly block, each with a percent used and a reset. Marid writes the latest one to `tmp/musecode-usage.json` in the instance home (owner-only, written atomically, and a turn that observed an older state never replaces a newer one).

The Limits page and `jinn limits` read it:

| Field | From |
| --- | --- |
| plan | the snapshot's `tier` |
| `5h` window | `window.usedPercent`, `windowDurationMins`, `resetsAtMs` |
| `weekly` window | `weekly.usedPercent`, `resetsAtMs` |

The snapshot is the only source: its status is `snapshot`, and it is `stale` when the window has since reset or the reading is more than six hours old. With no snapshot yet, the card says usage appears after the first Muse Code turn.

Muse Code also has a `usage/read` method, which answers only for usage the host process has itself observed. A host started just to be asked has observed none (checked on 1.4.8), so Marid does not ask. Whether it answers against real credentials is unverified, and a live read is a follow-up; until it is checked, Muse Code is not one of the engines the Limits page treats as live.

A window at 100% or more counts as spent until its reset, as it does for Claude and Codex. Marid records Muse Code as exhausted, and a new session that would have started on it starts on its `fallback` engine instead, until the window reopens.

---

## Known limits

- **Local only.** Muse Code does not run on remote (SSH) hosts.
- **No department-scoped sessions.** Employees in a scoped or dedicated department run on Claude only.
- **Muse's OS sandbox is off.** Marid passes `--disable-sandbox`, as the host's sandbox needs a capability many machines lack, and it runs its other unattended engines unsandboxed too.
- **An MCP server that cannot start is skipped without a sign.** This covers every server, the company toolset included. Muse Code drops it and reports nothing: no notification, no item and no status, and the turn completes normally. A session can therefore run without its tools, and the model will not say so. To check, ask the session to list its MCP tools, or look at what the host sends the model: start the gateway with `MUSE_TRANSPORT_TRACE=1` in its environment and the log level at `debug`. Muse then writes each provider request to stderr, which Marid logs as `[muse stderr]`. The request's `tools` array has one `mcp__<server>` namespace per server that started (for the company toolset, `mcp__jinn`); a server that failed has no namespace. The trace includes the full prompt, so turn it off again when you are done.
- **Reminder agents add provider calls.** With them on (Muse's default), every turn makes two or three extra calls, and `turn/foregroundCompleted` arrives before the blocking reminders finish. Marid waits for `turn/completed`. To turn them off, give the employee `cliFlags: ["-c", "run.reminder_roster=[]"]`.
- **No terminal view.** Muse Code has a TUI (`muse resume <session>`), but Marid shows no CLI view for it.
- **No usage until a turn has run.** The Limits card is empty until the first Muse Code turn reports usage.
