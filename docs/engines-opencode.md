# opencode Engine

[opencode](https://opencode.ai) is an open-source terminal coding agent that brings its own provider. By default Jinn wires it in as a batch engine: one `opencode run` per turn, JSON on stdout, no PTY. The opt-in [server mode](#server-mode-and-the-terminal-view) keeps an `opencode serve` per session instead, and adds the dashboard terminal view.

> **Metered cost.** Like Pi and Hermes, and unlike the subscription-wrapped engines (claude, codex, grok), opencode bills on whichever provider you authenticate. `opencode auth login` supports an Anthropic Claude Pro/Max login as well as API keys — check which one you signed in with before running opencode on high-volume work.

---

## Installation

```bash
curl -fsSL https://opencode.ai/install | bash
```

Then sign in:

```bash
opencode auth login
```

Credentials live in opencode's own data directory (`~/.local/share/opencode/auth.json` on Linux/macOS for 1.x; OpenCode 2 keeps them in its database there, importing `auth.json` the first time it opens a 1.x data directory). Jinn only resolves the binary from `PATH`; every provider decision is the CLI's own.

Check what the gateway will see:

```bash
opencode models
```

---

## Supported opencode versions

| Mode | opencode 1.x | OpenCode 2 (2.x) |
| --- | --- | --- |
| `run` (default) | Supported. | Supported. Marid reads the binary's `--version` and adds `--standalone` to a 2.x turn, so the v2 CLI does not start (and leave behind) its background service. |
| `server` | Supported from **1.18.31**. | Supported from **2.0.28** (verified on 2.0.28 and 2.0.29). See [Server mode on OpenCode 2](#server-mode-on-opencode-2). |

A server that reports an older version than these, or no version, or a major
past 2, is refused. That host's turns then run in `run` mode for an hour
before server mode is tried again.

Each host is driven in the API its own binary speaks. A 1.x server's health
answer (`/global/health`) is JSON with its version. A 2.x server answers every
1.x route with its web UI's page, so Marid then reads the version from
`/api/info`. One gateway can therefore run 1.x and 2.x hosts side by side, and
a host can be upgraded on its own. [opencode-2-upgrade.md](opencode-2-upgrade.md)
is the step-by-step upgrade and rollback for a host. It covers the binary,
plugins, credentials, the file indexer and the background service.

**Version detection.** Marid reads the version from the binary itself before
starting anything. The local binary's version is cached by its real path and
modification time, so a symlink swap is seen at once. A remote host's comes
with its facts (`opencode --version`), which the gateway reads once per run.
After upgrading a remote host, `jinn restart`. Until then a server start
there notices the mismatch and restages once.

The version decides four things:
- the shape of the staged MCP config (see [The company toolset](#the-company-toolset-mcp));
- `--standalone` on `run` turns and on model discovery (`opencode models`, `opencode api model.list`);
- the terminal view's argv;
- which server turn drives the session.

**Your `cliFlags` win.** Any `--standalone`, `--standalone=<value>` or
`--no-standalone` there is passed as written and Marid adds nothing.

**Plugins.** opencode plugins written for 1.x (a default-exported `Plugin`
factory) do not load on 2.x (`Plugin must export a default definition with an
id and an effect or setup function`). [`examples/opencode-plugins`](../examples/opencode-plugins/)
has 2.x replacements for a provider-fallback plugin and a pre-stream-400
retry.

---

## Configuration

```yaml
engines:
  opencode:
    bin: opencode          # optional — PATH-resolved when absent
    model: anthropic/claude-sonnet-5
    fallback: [pi]         # engines to try when opencode cannot serve a turn
    disableFff: true       # default; false lets opencode run its file indexer
    commandTimeoutMs: 1800000  # default (30 min): the longest one shell command may run; 0 turns it off
```

Model ids are opencode's own `provider/model` form, exactly as `opencode models` prints them. The model half may contain further slashes (`openrouter/meta-llama/llama-4`); only the first one is structural.

**Effort levels are the model's variants.** opencode's reasoning-effort control is the model *variant*, and opencode lists the variants each model has (`high` for one model, `low` … `max` for another, none for a third): 1.x in `opencode models --verbose`, 2.x in its server's `GET /api/model`, read with `opencode api model.list --standalone`. Discovery turns those into the model's effort levels, so the effort picker offers exactly what the model accepts, and a model with no variants has no picker. The level reaches opencode as `run --variant <level>` (1.x), `-m provider/model#<level>` (2.x `run`), the prompt body's `variant` (1.x server) or the `variant` of the session's model ref (2.x server; the model is posted again when only the variant changed). A level the model does not list is never sent, and neither is `default`. A `--variant` in `cliFlags` wins over the picker's level (on a 2.x `run`, which has no such flag, it is moved onto the model as `#<level>`). A turn with no model named (no model on the session and no `engines.opencode.model`) sends no variant, since opencode picks its own model.

The `models.opencode` block can still state a model's levels by hand: an entry with `supportsEffort: true` and `effortLevels` turns a model's picker on, a list on a model that already has levels replaces them, and `supportsEffort: false` switches a model's picker off:

```yaml
models:
  opencode:
    models:
      - { id: opencode/some-model, label: some-model, supportsEffort: true, effortLevels: [low, medium, high] }
```

The terminal view is a client of the session's server and sends no turns of its own, so it has no variant to pass.

### The file indexer (`disableFff`)

opencode bundles an fff file indexer and watcher that pegs a CPU on a work root with many nested repos or worktrees (anomalyco/opencode#50719; still present on opencode 1.19.0, and still bundled and on by default in OpenCode 2.0.29, which honours the same variable). By default (`disableFff` true, or absent) Marid sets `OPENCODE_DISABLE_FFF=1` on every opencode process it starts: `run` turns and servers in server mode, the terminal view's attach client, locally and over SSH. A host wrapper script around the `opencode` binary that exports the variable is no longer needed (and `opencode upgrade` overwrites such a wrapper anyway).

`disableFff: false` means only that Marid does not set the variable. One that the gateway inherits from its own environment is not stripped, since Marid's environment scrub leaves operator `OPENCODE_DISABLE_*` settings alone.

The option is read each time a process is spawned, so a hot reload applies to the next process. A server that is already running keeps the environment it started with until it is restarted (it stops when it goes idle, or when you stop the session's server).

The option can be dropped once opencode bundles `@ff-labs/fff-bun` >= 0.11, or anomalyco/opencode#50719 is fixed.

### Command timeout (`commandTimeoutMs`)

opencode's shell tool (`bash` on 1.x, `shell` on 2.x) runs a command for as long as the model asks:

- **1.x** has a 2 min default, but takes any `timeout` the model passes.
- **2.x** defaults to 120 s in the foreground and takes `0` for none. Background commands have no timeout at all.

So a hung command, or one waiting for input, can hold a turn indefinitely. Upgrading to 2.x does not change that.

`commandTimeoutMs` (default 30 minutes; `0` turns it off) is a hard ceiling:

- **Where it applies:** every shell command an opencode turn runs, on 1.x and 2.x, locally and on remote hosts.
- **What happens:** a command that asks for more, for `0`, or for no timeout gets the ceiling. opencode stops it there and tells the model (`Command exceeded timeout of … ms`), and the turn carries on. A smaller timeout the model asks for is kept.
- **Background commands:** 2.x background commands (`background: true`, such as a dev server) are not capped. They do not hold the turn.

**How it is enforced:** a small opencode plugin in this package (`assets/opencode/command-timeout/`) caps each shell call's timeout before it runs. Marid lists it in the config it stages for each session, beside the operator's own plugins: as a module on 1.x (`plugin`) and as a package on 2.x (`plugins`). The ceiling travels in `JINN_OPENCODE_COMMAND_TIMEOUT_MS`.

- A remote host uses the plugin from its own `jinn-cli` install, so it needs no setup.
- The value is read each time a process starts, as for `disableFff`. A server already running keeps the ceiling it started with.
- An opencode run by hand in a terminal does not get the ceiling.

### Usage limits

opencode publishes no account quota, and neither does OpenCode Go. Go's allowance is documented, though: each model gets a monthly limit in dollars of usage, metered over three windows — five hours at 20% of it, seven days at 50%, thirty days at 100%. opencode reports every step's cost at the provider's own prices, and jinn records every turn's cost with a timestamp, so jinn can meter its own opencode spend against those windows:

```yaml
engines:
  opencode:
    model: opencode-go/deepseek-v4.1-flash
    usageLimits:
      monthlyUsd:
        opencode-go/*: 60                  # every Go model not named below
        opencode-go/deepseek-v4-pro: 15    # an exact id beats its provider's wildcard
```

Take the numbers from the Go pricing table for the models you use. A model that matches no key is not metered: pay-per-token providers such as OpenRouter have no window to run out of.

With that set, the Limits page and `jinn limits` show opencode's windows for the engine's default model. `jinn limits` (and `GET /api/engine-limits`) also list a bucket per metered model; the Limits page does not render buckets yet. If the default model matches no key, opencode reads as unsupported with the reason, because nothing configured can speak for the engine. When a window is fully spent, opencode is recorded as **exhausted until the moment the ledger says it reopens**. That is the same record a spent Claude window writes, and it is read the same way:

- A new session whose engine is only a preference (an employee's configured `engine: opencode`, not one named in the request) starts on the first healthy engine in `engines.opencode.fallback`.
- A mid-turn rate-limit fallback from another engine (for example `engines.claude.fallback: [opencode]`) skips opencode for the next healthy member of its chain.

Every one of those is routing through a fallback chain, so the record only moves work where there is somewhere else to go. **Nothing is refused**: if no healthy alternative is left, the turn runs on opencode anyway, exactly as before. To make an exhausted opencode route away from itself, give it a chain: `engines.opencode.fallback: [pi]`, say.

The reading refreshes with the engine-health refresh (every 15 minutes) and whenever the Limits page or `jinn limits` reads it.

What the meter does not see:

- **opencode used by hand**, outside jinn. Only turns jinn ran are in the ledger.
- **Which model opencode picked for itself.** A turn is charged to the model jinn handed opencode, fixed when the turn is recorded, so changing `engines.opencode.model` later does not move old spend. A turn run with no model at all (neither the session nor `engines.opencode.model` names one, so opencode used its own default) is charged to whatever the default is when it is read.
- **The provider's own clock.** Windows are treated as trailing. That is exact if Go's windows roll, and conservative if they are anchored at first use.
- **A per-model engine record.** Engine health has one record per engine, so only the **default model's** windows can mark opencode out. A spent pinned model shows in its bucket, and its next refusal is handled reactively, as before.

A turn that the opencode-rate-limit plugin moves to another provider is charged to the model jinn asked for. The plugin only moves a turn after that model has refused it, so the over-count errs towards reading the allowance as spent, never as spare.

---

## Invocation contract

```
opencode run --format json --dangerously-skip-permissions \
  [-m provider/model] [-s <session>]
```

The prompt goes on **stdin**, never argv: `run` takes its message as trailing positionals, so a prompt beginning with a dash would be read as a flag, and a long one would run into `ARG_MAX`.

opencode emits one JSON event per stdout line:

| event | what jinn takes from it |
| --- | --- |
| `step_start` | nothing — a model round trip began |
| `tool_use` | `part.tool`, `part.callID`, `part.state` → the live tool view |
| `text` | `part.text` → the answer (the last text part wins) |
| `step_finish` | `part.tokens`, `part.cost` → accounting |
| `error` | `error.name` + `error.data.message` → the turn's error |

Two things about that table are easy to get wrong and are worth stating plainly:

- **A turn is several steps.** One `step_finish` arrives per model round trip, and its `tokens` and `cost` are for that step alone. Cost is summed across the turn; the context reading is the last step's `input + cache.read + cache.write`, because that is how full the window is now.
- **Failures arrive on stdout as JSON**, not on stderr, and the process exits 1. An engine that reads only the exit code and stderr reports a turn that produced nothing, with no reason attached.

### Sessions and resume

opencode assigns the session id (`ses_…`) and reports it on every event, including the `error` one. Jinn captures it as `EngineResult.sessionId` and continues the conversation with `-s` on the next turn — the same contract codex uses, and the opposite of Pi, whose session id is jinn's own.

### Permissions

`--dangerously-skip-permissions` is the only approval lever jinn pulls. It auto-approves everything **not explicitly denied**, so an operator who denied `bash` in their own opencode config keeps that deny. Jinn deliberately does not write a `permission` block into the staged config, which would silently take that away.

---

## The company toolset (MCP)

opencode reads a real MCP config, which makes this the cheapest wiring of any engine here — no generated extension module (Pi), no config dialect of its own (Claude). Jinn projects the session's already-resolved server set into opencode's `mcp` block and points the CLI at it with `OPENCODE_CONFIG`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jinn": {
      "type": "local",
      "command": ["/usr/bin/node", "/…/server.js", "--home", "/…/.jinn"],
      "environment": { "JINN_SESSION_ID": "…", "JINN_SESSION_CAPABILITY": "…" },
      "enabled": true
    }
  }
}
```

The file is written mode 0600 under `$JINN_HOME/tmp/opencode/<session>/` and removed when the turn settles. It carries the session's capability because opencode launches the server as a real subprocess with that `environment` — the same place Claude's staged `mcp.json` carries it. The gateway **bearer** is not in it: the built-in server resolves that from `<JINN_HOME>/gateway.json`.

`OPENCODE_CONFIG` **merges** with the operator's own config rather than replacing it, so this file carries only what jinn adds.

A session with no MCP servers stages no file and sets no `OPENCODE_CONFIG` at all — opencode's own config on that machine is left entirely alone.

**On OpenCode 2** the file is staged in 2.x's own shape. A 1.x-shaped file
still loads, but 2.x then offers MCP tools only through its "Code Mode": one
`execute` tool that runs code against them. The model would never see
`jinn_*` tools, and a confined walk agent would be left with none. Only the
native shape takes the per-server switch that turns that off:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": { "servers": { "jinn": { "type": "local", "command": ["…"], "environment": { "…": "…" }, "codemode": false } } },
  "agents": { "jinn-walk": { "mode": "primary", "permissions": [{ "action": "*", "resource": "*", "effect": "deny" }, { "action": "jinn_walk_board", "resource": "*", "effect": "allow" }] } }
}
```

2.x also connects MCP servers lazily, on the first request that asks about
them. So a server is handed to its first turn only once `GET /api/mcp` shows
the staged servers connected, plus one second: a session created straight
after `connected` could still miss their tools. A server that does not
connect within the bootstrap budget is logged (`MCP server(s) not
connected`), and the turn runs without its tools.

---

## Remote employees

opencode is one of the three engines that can relocate a turn to another machine over SSH (`REMOTE_ENGINE_NAMES`), alongside Claude Code and Pi. See [remote-execution.md](remote-execution.md) for the whole picture; the opencode-specific parts:

- The prerequisite on the remote host is `opencode` on the **non-interactive** PATH, signed in there. `jinn remote status` reports which binary it found.
- No remote tty (`ssh -T`). opencode's stdout is a JSON stream jinn parses line by line, and a tty would fold the remote stderr into it.
- **Nothing relocates opencode's data directory.** Its session store and its `auth.json` sit side by side under the remote user's home, so moving the store would take the login with it and every turn would start unauthenticated. opencode generates its own session ids, so sessions sharing that one store cannot collide the way Pi's would — which is why there is no opencode equivalent of Pi's staged `--session-dir`.
- `OPENCODE_DISABLE_AUTOUPDATE=1` is set on every turn, local and remote: a self-upgrade between two turns of one session would swap the binary under a conversation opencode is still holding in its own store.
- **Provider keys in the remote login environment are left alone.** This is deliberate, and the opposite of the Claude engine's rule: Claude Code runs on subscription auth, where an inherited `ANTHROPIC_API_KEY` would silently move the session onto metered billing, so it is stripped. opencode drives whichever provider the operator authenticated on that machine, and for a key-authenticated provider an inherited key is how it works at all. Only the markers that tell a nested CLI it is running inside another agent are stripped (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `JINN_HOME_IDENTITY`, `JINN_TAKE_PORT`).
- **Attachments are refused** on a remote turn, the same as Pi and remote Claude: the file paths are the gateway's and name nothing on the other machine.

---

## Server mode and the terminal view

```yaml
engines:
  opencode:
    mode: server          # default: run
    server:               # all optional
      maxIdle: 2          # idle warm servers kept per host
      maxIdleByHost:      # per-host override; `local` is the gateway itself,
        local: 1          # anything else is an employee's remoteHost as written
        10.0.0.5: 6
      idleTtlMs: 900000   # an idle server is stopped after 15 minutes
      startTimeoutMs: 30000       # to answer its health check
      bootstrapTimeoutMs: 120000  # then to bootstrap its instance (see below)
```

opencode is client/server: its TUI is a client of an HTTP server with a documented API (`GET /doc` on a running server), and `opencode attach <url>` runs the TUI against a server that is already running. Server mode uses that.

- **One `opencode serve` per Jinn session**, bound to `127.0.0.1` on a free port and protected by a random per-server password (`OPENCODE_SERVER_PASSWORD`, HTTP basic auth). It is started with the session's MCP config, exactly as a `run` turn stages it, so the jinn tools and the session's identity live in the server.
- **Each turn is sent by the gateway over the server's API.** It subscribes to `/event` (SSE), creates the opencode session (`POST /session`) or resumes the one it has, and posts the prompt with `POST /session/<id>/prompt_async` under a message id it generates (opencode's own id format), passing the model as `{providerID, modelID}` and `--agent` from `cliFlags` if one is set. Each `message.part.updated` / `session.error` event is turned into the line `opencode run --format json` would have printed for it: the same type, sessionID and Part object, minus the `timestamp` field that `run` adds and nothing reads. The same parser reads it, so everything under *Invocation contract* above still holds. The turn ends when its own reply is done: a completed assistant message answering the turn's prompt, with a finish reason other than a tool round trip. That's opencode's own loop-exit condition. The session going idle (`session.status` idle, which is what `run` itself ends on, or `session.idle`) is the fallback, for example after an abort. The turn doesn't wait for the session to go idle, because the session stays busy while anything queued after the turn runs, including someone else's prompt waiting on a permission. Other `cliFlags` are ignored in server mode, with a warning.
- **A turn is its own messages, not the whole session.** Because the prompt is posted under a known message id, the turn counts only replies whose `parentID` is that id, and the sub-sessions those replies spawn. Only their parts become its answer, and only their permission prompts are its to grant. Anything else in the same opencode session belongs to someone else, typically a prompt the operator sent from the terminal. It isn't taken as the turn's answer, and its permission prompts are left for the operator.
- **Why not `opencode run --attach`.** That was the first design. On opencode 1.18.31, the attached client prints `step_start` and exits 0 before the answer arrives whenever the session's directory isn't a git repository. The server itself finishes the turn correctly. This reproduced 5/5 on build-host in a non-git directory and 0/5 inside a repo, and `--dir` doesn't help. A remote employee's working root (`/srv/jinn-work/main`) is exactly such a directory. The `opencode attach` TUI isn't affected.
- **Approvals** match `opencode run --dangerously-skip-permissions`. A permission the server asks for (`permission.asked`) is granted `once`, and anything the operator explicitly denied in their opencode config is refused by the server without asking. `opencode run` doesn't offer the `question` tool (the model asking the user to choose; verified on 1.18.31), so each server-mode prompt turns it off with `tools: {question: false}`. A question that still arrives from a sub-session is rejected rather than left waiting. All of this applies only to the turn's own replies and the sub-sessions they spawn. A prompt the operator sent in the same session keeps its own approval prompts and questions.
- **A request the operator cancelled is named as cancelled.** A prompt the operator typed in the terminal and then stopped with Esc stays in the session's history, unanswered, and the model reads the next prompt as a follow-up to it. In live runs the next Jinn turn's own reply carried an aborted `/etc/hostname` read out in 10 of 11 runs, and since the reply was the turn's own, the turn granted its permission. So before a resumed turn posts, it reads the session's newest 100 messages. If the history ends in operator requests that were cancelled, the prompt carries a first text part, `synthetic: true` (the model reads it; opencode's TUI does not show it as typed), that quotes those requests and says the user cancelled them and they must not be carried out unless the new message asks again. The operator chose telling the model over refusing the turn's permissions or reverting the operator's messages, so permissions are still granted as above. Jinn's own prompts are posted with `metadata: {jinn: "prompt"}` (opencode stores and returns a text part's metadata; verified on 1.18.32), which is how the walk tells them apart. A request was cancelled when its newest reply was aborted (`MessageAbortedError`), or when it has no reply at all, the session is idle, and it was created before an abort ended, because that Esc dropped it from the queue. A prompt created after the abort, one opencode hasn't picked up yet (that takes up to about 700 ms) or one that failed before replying, wasn't dropped by it. For example, a follow-up the operator typed while the first request waited on a permission; on 1.18.32 the next turn's model carried such a follow-up out in 4/4 runs. A Jinn prompt that was aborted or never answered is stepped over, never reported as cancelled: Jinn stops its own turns for reasons that aren't the user's (a restart, a timeout). A request that was answered, failed another way, is still running, or (the session busy) waits to run ends the walk. Against real opencode 1.18.32 and `opencode-go/deepseek-v4.1-flash`, with the operator's aborted `/etc/hostname` read in the history: without the notice the next turn read the file in 16/16 probe runs. With it the read happened in 0/26, across three follow-up prompts: the smoke's `Reply with exactly: SMOKE_THREE_OK`, an unrelated question, and a bare `Carry on.`. It is advice to the model, not enforcement. A model that ignores it can still do what was cancelled, with the turn's permissions.
- **A turn that subscribes mid-busy-period.** The stream shows a reply only from its first event onwards, so the same pre-post read also seeds what the turn missed. With the session busy, a reply someone else started that is still running is classed as theirs and as the one running (only when busy: a server killed mid-reply leaves a reply with no completion and no error behind), so an error that ends it (the operator's Esc, an APIError) isn't taken as this turn's. If `/session/status` lists the session as busy, the idle that ends the busy period still ends the turn. An idle only counts once the turn's prompt has been sent: an earlier one ends someone else's busy period. An abort drops every prompt queued behind the one it stops (verified on 1.18.32; the prompt stays in the history with no reply). A turn whose session goes idle with no reply to its prompt at all, and is still not busy, reports `PromptNotRun` rather than a silent empty success.
- **Supported versions: opencode 1.x from 1.18.31, OpenCode 2 from 2.0.28.** Server mode reads the server's own event and message shapes, which is a less stable contract than the CLI's `--format json`. A server older than its API's minimum, or one that reports no version, is refused. So is a major past 2. That host's turns then run in `run` mode for an hour before server mode is retried. Everything in this list describes the 1.x API; [Server mode on OpenCode 2](#server-mode-on-opencode-2) has what differs on 2.x.
- **If the server's API changes, the host degrades to `run` mode instead of dropping events.** When a turn goes idle having translated neither an answer nor an error, Jinn reads the session's stored messages. If the answer is there, the stream didn't carry it in a shape Jinn recognises: the turn takes its result from the store (same parts, same translation), the host is switched to `run` mode for an hour, and the session's server is stopped. A turn whose `session.idle` never arrives is caught by a 30-second status poll and handled the same way. A store with neither an answer nor an error is not drift: a reply the server left unfinished, with the session idle, fails the turn ("the opencode server ended the turn without a final assistant response", followed by how the reply ended, e.g. `(its reply finished "stop" with 0 output tokens)`, which is what an empty answer from the provider looks like; or "stopped running the turn before its reply finished" when only the status poll saw it end), and the host keeps server mode and its server.
- **Provider errors, retries and fallbacks.** opencode does not give up on a provider at the first error: it retries the request in place, and reports each attempt as a `retry` session status carrying the provider's message (on 1.18.35 and 1.19.0, up to five attempts; then `session.error`, the idle, and the failed reply). A provider fallback can also take a turn over. The opencode-rate-limit plugin, on a rate-limit retry or error, aborts the session and posts the prompt's text again, without Jinn's metadata, as a new message on its fallback model. So a turn handles these cases:
  - **A turn waits instead of ending early.** A turn with no text answer does not end at the first idle or finished reply. It waits 2 s, or 5 s when the idle comes during a provider retry. In that time, any of these takes it up again: a newer reply to its prompt, its prompt re-sent, or a retry of its own reply. A turn with its answer ends as before.
  - **A re-sent prompt becomes part of the turn.** While the turn has no answer, a user message that repeats its prompt text word for word is adopted as the turn's prompt. Replies to it are the turn's answer, its permissions are granted, and a stop aborts it. Its text part is given Jinn's prompt metadata, so the next turn's history walk reads it as a Jinn prompt, never as the operator's request.
  - **Only the turn's own retries count.** A `retry` or busy status belongs to the session, which may be running someone else's prompt. It counts for the turn only while the turn's own reply runs, or before any reply.
  - **A failed turn names the provider's error.** A turn that ends without an answer after a retry leads its error with the provider's message, e.g. `opencode's provider failed: Go usage limit exceeded; the opencode server ended the turn without a final assistant response (…)`. It reads as a usage limit, so the gateway's rate-limit handling applies.
  - **A far-off retry ends the turn.** When opencode's next retry is more than 2 minutes away (a usage window, not a blip) and nothing else happens for 15 s, the turn ends with the provider's words and the retry time as its reset, and the pending retry is aborted on the server. opencode is then recorded as exhausted until that time, the same record as a spent window (see *Usage limits*), even if another provider or model would work.
- **A server lost under a turn fails that turn, not the conversation.** A server stopped mid-turn (idle-cap reaping, a replacement, an ssh drop) ends the turn with an event-stream error. Once the server has accepted the turn's prompt, the session is known to exist, so the failure keeps the session's resume id and the next turn carries on the same opencode session. A resume id the server does not know is still a dead session. `/compact` waits for summarize's answer over a plain HTTP request bounded only by its 15-minute timeout: Node's `fetch` gives up on any response whose headers take more than 300 s, which failed long summaries as `fetch failed`.
- **The terminal view** (the dashboard's CLI toggle, offered only in server mode) is `opencode attach <server> -s <session>` in a PTY; on OpenCode 2, which has no `attach`, it is `opencode --server <server> -s <session>` (the password comes from `OPENCODE_SERVER_PASSWORD` either way). It shows Jinn's turns live, because they run in the same server. A terminal opened while a new chat's first turn is starting waits for that turn to create its opencode session, then attaches on it. When a turn names a session the view isn't on (a view that attached with none, or a resume that found its session gone), the attach client is restarted with `-s` on the new session. `POST /tui/select-session` isn't used: opencode delivers it only to TUIs already connected to the server's event stream, and an attach client takes a few seconds to connect (about 3 s on build-host with 1.18.31, longer over ssh). A client that misses it stays on opencode's home screen while the turn runs unseen.
- **Two ways to type in the CLI view** (see [`cli-terminal.md`](cli-terminal.md)). The chat composer sends an ordinary message: for opencode that becomes a Jinn turn on the session's server, queued, recorded in the Jinn transcript and shown live in the TUI. On a desktop the terminal itself is also a real terminal: click it and keys, pastes, the wheel and the mouse go straight to `opencode attach`, so you can scroll opencode's message view, click its controls and drag-select, and type into its own prompt. A prompt typed there runs in the opencode session like one typed in a local TUI; it is **not** copied into the Jinn chat (see *Known limits*). Esc is opencode's own interrupt key. Pressed during a Jinn turn, it aborts that turn on the server, and the turn ends with opencode's abort error rather than silently.
- **Raw `stdin` frames on `/ws/pty`** (the web client never sends them; it sends `input` frames, which go to the attach client's PTY unchanged; a programmatic client can send `stdin`) go into the session through the server's `prompt_async` API. While a Jinn turn is running in that session they are held and sent when the turn ends, so they can't join the turn's busy period. If the terminal closes before the turn ends, held text is not sent, and a warning is logged.
- **Interrupts abort the turn on the server, and are confirmed.** Dropping the connection doesn't stop a turn: the server keeps generating and running tools. An abort that reaches opencode before it has picked the prompt up is also silently lost, and the prompt then runs anyway. On 1.18.31, an abort 0 ms after the post cancelled the prompt, one at 20 ms was lost, and every abort after the session went busy stopped it. The session becomes busy between about 20 and 710 ms after the post. So an interrupt waits for the prompt's POST to finish, then keeps aborting the turn's own session (`POST /session/<id>/abort`) until the session has stayed not-busy for 1.5 seconds, with the turn's reply ended or never started. If that isn't achieved within 15 seconds, the whole server is stopped, which ends its tools too. Only the turn's own session is aborted. An interrupt that arrives while the session's server is still starting is recorded, and the turn then posts nothing.
- **A server is ready once its instance has bootstrapped, not just once it answers health.** `/global/health` answers without an instance. The first request that needs one, including `/event` (opencode sends `server.connected` only after bootstrap), loads the config and plugins for the server's directory. A config directory whose plugins' dependencies aren't installed yet gets them installed first, from npm (`@opencode-ai/plugin`, or an npm plugin not yet cached). On harry-box with opencode 1.18.32, a first `/event` took 5.6–24.5 s in that case, against about 0.2 s once installed. MCP servers are not part of it; they connect lazily. So after the health check the pool opens `/event` once and waits for `server.connected`, up to `bootstrapTimeoutMs`, and the turn's own stream then connects at once within its 15-second budget. Before this, the first turn on a server paid for the bootstrap inside that budget and failed with `the event stream did not connect`. That happened to the first turn after a plugin was added or bumped, or on a host whose opencode cache was new. The ready log line reports how long the bootstrap took. An interrupt that arrives while the server is still bootstrapping ends the turn at once, with nothing posted, and the server carries on starting for the next turn.
- **If the server won't start** (no health answer, a refused version, or a bootstrap past `bootstrapTimeoutMs`), the turn runs as a plain `opencode run` and a warning is logged. The turn doesn't fail.
- **A server is replaced when a turn needs a different one**: a changed MCP set, a different host or cwd, or a different binary. The terminal view never replaces a server; it attaches to whatever the session already has.

**Remote employees.** The server runs on the employee's host, staged the same way a remote `run` turn is. It uses one long-lived `ssh -tt` that holds the reverse tunnel its MCP servers reach the gateway through, plus a `-L` forward on the gateway's loopback for the server's API. Turns, aborts and health checks all go through that forward, so a turn needs no ssh of its own. The terminal view runs `opencode attach` over its own ssh on that host, with no tunnel. The password is written to the session's 0600 env file and never appears on a command line. The server's pid is recorded (`tmp/opencode-server.pid`) so a deliberate stop can end the server and its tools. A dropped link also hangs the server up, because it has a tty.

**Resources.** A warm server is a full opencode process: about 650 MB RSS on build-host (opencode 1.18.31), plus its MCP servers. An attached terminal adds about 310 MB while it's open. Idle servers are limited per host (`maxIdle` / `maxIdleByHost`) and by age (`idleTtlMs`), and a server on the gateway host also counts toward `engines.claude.maxLivePtys` (see below for which cap applies to which host). A server that is serving a turn or is attached to a terminal is never counted or reaped. A terminal is closed 60 seconds after the last browser socket on it goes away.

**Which idle cap applies to which host.** Idle limits are scoped per host. A running turn or an attached terminal is never counted.

| Process | Gateway host (`local`) | Remote host |
|---|---|---|
| opencode warm server | `server.maxIdleByHost.local` (else `maxIdle`) **and** `engines.claude.maxLivePtys` | `server.maxIdleByHost.<remoteHost>` (else `maxIdle`) only |
| Claude and other interactive PTYs | `engines.claude.maxLivePtys` | `engines.claude.maxLivePtysByHost.<remoteHost>`, else `maxLivePtys` again, counted for that host alone |

The host key is the employee's `remoteHost` exactly as written. `maxLivePtys` (default 8) protects the gateway host's memory, so a remote host's idle processes no longer use it up, and raising a remote host's budget never lets the gateway host hold more local idle processes.

```yaml
engines:
  claude:
    maxLivePtys: 2              # the gateway host: at most 2 idle processes
    maxLivePtysByHost:          # optional; a remote host not listed gets maxLivePtys
      build-box: 6
  opencode:
    server:
      maxIdleByHost:
        build-box: 8            # remote opencode servers: this count alone
```

**Upgrading.** A config with no `maxLivePtysByHost` keeps its limits on the gateway host. What changes is a remote host. Its idle opencode servers no longer count toward `maxLivePtys`, so only `maxIdleByHost` bounds them. Its idle Claude PTYs used to share the one gateway-wide count with everything else; each remote host now has a count of its own (`maxLivePtys` unless `maxLivePtysByHost` names it), so the total across hosts can be higher than before. Set `maxLivePtysByHost` for a remote host to keep it lower.

**Switching back** to `mode: run` stops every warm server before the next turn runs as a plain `opencode run`, so two processes never write one session.

---

## Server mode on OpenCode 2

A 2.x server (`/api/*`) is driven by `opencode-v2-turn.ts`. It is the same
contract as on 1.x: one server per session, the same password, ssh forwards,
pool, idle caps and `run` fallback. The 2.x stream is translated into the
same `run`-style lines (`opencode-v2-events.ts`), so answers, tool calls,
accounting and rate-limit handling are as above. The differences, all
verified against 2.0.28 and 2.0.29:

- **Prompting.**
  - The model belongs to the session on 2.x, so a turn that names another model switches it first (`POST /api/session/<id>/model`); `--agent` from `cliFlags` likewise.
  - The prompt goes to `POST /api/session/<id>/prompt` under an id the turn makes, with `delivery: queue`. If the operator's own prompt is running in the session, the turn's waits for it.
- **Ownership.**
  - 2.x names the input each step answers: `session.inbox.delivered` gives the input, and every step event gives its assistant message. The steps after the turn's prompt is delivered are the turn's.
  - An input steered in while the turn runs keeps the turn going. That is what the terminal sends, and what a client gets with no `delivery` at all. 2.x hands it to the running input at its next step, and the model answers both there, so the turn's answer can address it too. Only an input someone else queued after the turn's prompt ends the turn's ownership, and that runs once the turn's reply is done.
  - An execution ends with an explicit outcome: `session.execution.succeeded`, `failed` or `interrupted`. That plays the role of 1.x's idle, with the same short settle wait for a turn that has no text answer yet.
  - The 30-second status poll reads `GET /api/session/active`.
- **Approvals and questions.**
  - A permission asked by one of the turn's steps is answered `once`.
  - Sessions the turn creates deny the `question` tool, which takes it out of the tool list. A question that still arrives (a form) is dismissed.
- **Provider retries and fallbacks.**
  - opencode reports a retry as `session.retry.scheduled {attempt, at, error}`, and the 1.x rules apply: wait, name the provider's error, and give up on a retry more than 2 minutes away.
  - A fallback plugin on 2.x switches the session's model from the retry hook, so the fallback answer arrives inside the same turn (see `examples/opencode-plugins`). 1.x plugins, which re-post the prompt instead, do not load on 2.x.
- **Stops.**
  - A turn whose prompt is still waiting in the inbox is taken back out (`DELETE …/inbox/<id>`), and the operator's execution is not touched.
  - Otherwise the session is interrupted (`POST …/interrupt`), and interrupted again until it has stayed idle for 1.5 s. After 15 s the server is stopped instead.
- **What the next turn must say.** 2.x cannot change a delivered message, and each input it delivers, a synthetic one included, gets a model step of its own. So the things a later turn must tell the model are kept in the session's metadata, under `jinn`, and put in front of the next prompt's text:
  - a Jinn prompt the user stopped;
  - the system prompt again after a compaction.

  Requests the operator cancelled in the terminal are found as on 1.x. On 2.x that means operator prompts delivered into an execution that ended `interrupted`.
- **Compaction.**
  - `/compact` queues 2.x's own compaction (`POST …/compact`) and waits for `session.compaction.ended`, or `failed`, which is the turn's error.
  - It uses the turn's model, selected first.
  - The re-seed of the system prompt rides on the next turn, as above.
- **Recovery.** A turn whose stream did not say how it ended reads its replies from `GET …/message`: the assistant items after its prompt, up to the next input.

## Model discovery

`opencode models` prints one `provider/model` per line — every model the installed CLI can actually reach. 1.x is asked `opencode models --verbose`, whose records carry each model's context window and variants. OpenCode 2 has no `--verbose`, so the same records are read from `opencode api model.list --standalone` (the CLI's private server answering `GET /api/model`), and only if that fails is the plain `opencode models --standalone` used, without windows or variants. Every 2.x command here takes `--standalone`; without it the v2 CLI starts its background service and leaves it running. Jinn refreshes this on the background timer and on `POST /api/engines/refresh`.

The catalog exists **only** once discovery has run: opencode ships no offline list, and what it reports depends entirely on which providers the operator configured on that machine. So an unrecognised model id is allowed through with a warning rather than refused — the same treatment Pi gets — because refusing it would reject an employee's own configured model for reasons that have nothing to do with the model.

---

## Known limits

- The terminal view exists only in server mode. In the default `run` mode there is no `/ws/pty` terminal for an opencode session.
- **Prompts that bypass Jinn are not copied into the Jinn chat.** Since the desktop terminal is interactive, so a prompt typed into opencode's own input box in the CLI view is one of these, alongside a programmatic `/ws/pty` `stdin` client and direct calls to the password-protected server API. It runs in the opencode session and shows in opencode's history and in the TUI, and the next Jinn turn's context includes it (it is the same opencode session), but the Jinn chat does not show it. Anything sent through the composer is in the transcript. Accepted as D5 and again.
- If a turn has to replace the server (see above) while an operator's own prompt is running in the terminal, that prompt is cut off.
- No quota reading from the provider. Unless `usageLimits` is configured (see Usage limits above), `jinn limits` lists opencode as unsupported. When it is configured, the reading is jinn's own estimate from its turn ledger, not the provider's account.
- **Run mode on OpenCode 2 cannot tell a lost conversation.** 2.x's `run -s <id>` creates a session under an id it does not know, rather than failing, so a `run` turn that resumes such an id starts with no history. Server mode is not affected (the session is looked up first, and an unknown one starts afresh with the transcript). It matters after an OpenCode 2 rollback and re-upgrade (see [opencode-2-upgrade.md](opencode-2-upgrade.md)).
- Attachments are named in the prompt text on a local turn and refused outright on a remote one. opencode's own `-f` flag is not wired up yet — Pi behaves the same way.
