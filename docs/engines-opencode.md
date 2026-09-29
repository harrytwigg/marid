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

Credentials live in opencode's own data directory (`~/.local/share/opencode/auth.json` on Linux/macOS). Jinn only resolves the binary from `PATH`; every provider decision is the CLI's own.

Check what the gateway will see:

```bash
opencode models
```

---

## Configuration

```yaml
engines:
  opencode:
    bin: opencode          # optional — PATH-resolved when absent
    model: anthropic/claude-sonnet-5
    fallback: [pi]         # engines to try when opencode cannot serve a turn
```

Model ids are opencode's own `provider/model` form, exactly as `opencode models` prints them. The model half may contain further slashes (`openrouter/meta-llama/llama-4`); only the first one is structural.

**No effort levels.** opencode has a `--variant` flag for provider-specific reasoning effort, but reports no list of which models accept which variants — so jinn offers no effort picker for opencode rather than offering one that silently does nothing.

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
- A Workflow node whose attempt failed on availability tries healthy substitutes before exhausted ones.

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
- **Minimum version: opencode 1.18.31.** Server mode reads the server's own event and Part shapes, which is a less stable contract than the CLI's `--format json`. A server that reports an older version on `/global/health`, or reports none, is refused. That host's turns then run in `run` mode for an hour before server mode is retried.
- **If the server's API changes, the host degrades to `run` mode instead of dropping events.** When a turn goes idle having translated neither an answer nor an error, Jinn reads the session's stored messages. If the answer is there, the stream didn't carry it in a shape Jinn recognises: the turn takes its result from the store (same parts, same translation), the host is switched to `run` mode for an hour, and the session's server is stopped. A turn whose `session.idle` never arrives is caught by a 30-second status poll and handled the same way.
- **The terminal view** (the dashboard's CLI toggle, offered only in server mode) is `opencode attach <server> -s <session>` in a PTY. It shows Jinn's turns live, because they run in the same server. A terminal opened while a new chat's first turn is starting waits for that turn to create its opencode session, then attaches on it. When a turn names a session the view isn't on (a view that attached with none, or a resume that found its session gone), the attach client is restarted with `-s` on the new session. `POST /tui/select-session` isn't used: opencode delivers it only to TUIs already connected to the server's event stream, and an attach client takes a few seconds to connect (about 3 s on build-host with 1.18.31, longer over ssh). A client that misses it stays on opencode's home screen while the turn runs unseen.
- **Two ways to type in the CLI view** (see [`cli-terminal.md`](cli-terminal.md)). The chat composer sends an ordinary message: for opencode that becomes a Jinn turn on the session's server, queued, recorded in the Jinn transcript and shown live in the TUI. On a desktop the terminal itself is also a real terminal: click it and keys, pastes, the wheel and the mouse go straight to `opencode attach`, so you can scroll opencode's message view, click its controls and drag-select, and type into its own prompt. A prompt typed there runs in the opencode session like one typed in a local TUI; it is **not** copied into the Jinn chat (see *Known limits*). Esc is opencode's own interrupt key. Pressed during a Jinn turn, it aborts that turn on the server, and the turn ends with opencode's abort error rather than silently.
- **Raw `stdin` frames on `/ws/pty`** (the web client never sends them; it sends `input` frames, which go to the attach client's PTY unchanged; a programmatic client can send `stdin`) go into the session through the server's `prompt_async` API. While a Jinn turn is running in that session they are held and sent when the turn ends, so they can't join the turn's busy period. If the terminal closes before the turn ends, held text is not sent, and a warning is logged.
- **Interrupts abort the turn on the server, and are confirmed.** Dropping the connection doesn't stop a turn: the server keeps generating and running tools. An abort that reaches opencode before it has picked the prompt up is also silently lost, and the prompt then runs anyway. On 1.18.31, an abort 0 ms after the post cancelled the prompt, one at 20 ms was lost, and every abort after the session went busy stopped it. The session becomes busy between about 20 and 710 ms after the post. So an interrupt waits for the prompt's POST to finish, then keeps aborting the turn's own session (`POST /session/<id>/abort`) until the session has stayed not-busy for 1.5 seconds, with the turn's reply ended or never started. If that isn't achieved within 15 seconds, the whole server is stopped, which ends its tools too. Only the turn's own session is aborted. An interrupt that arrives while the session's server is still starting is recorded, and the turn then posts nothing.
- **A server is ready once its instance has bootstrapped, not just once it answers health.** `/global/health` answers without an instance. The first request that needs one, including `/event` (opencode sends `server.connected` only after bootstrap), loads the config and plugins for the server's directory. A config directory whose plugins' dependencies aren't installed yet gets them installed first, from npm (`@opencode-ai/plugin`, or an npm plugin not yet cached). On harry-box with opencode 1.18.32, a first `/event` took 5.6–24.5 s in that case, against about 0.2 s once installed. MCP servers are not part of it; they connect lazily. So after the health check the pool opens `/event` once and waits for `server.connected`, up to `bootstrapTimeoutMs`, and the turn's own stream then connects at once within its 15-second budget. Before this, the first turn on a server paid for the bootstrap inside that budget and failed with `the event stream did not connect`. That happened to the first turn after a plugin was added or bumped, or on a host whose opencode cache was new. The ready log line reports how long the bootstrap took. An interrupt that arrives while the server is still bootstrapping ends the turn at once, with nothing posted, and the server carries on starting for the next turn.
- **If the server won't start** (no health answer, a refused version, or a bootstrap past `bootstrapTimeoutMs`), the turn runs as a plain `opencode run` and a warning is logged. The turn doesn't fail.
- **A server is replaced when a turn needs a different one**: a changed MCP set (for example a Workflow attempt), a different host or cwd, or a different binary. The terminal view never replaces a server; it attaches to whatever the session already has.

**Remote employees.** The server runs on the employee's host, staged the same way a remote `run` turn is. It uses one long-lived `ssh -tt` that holds the reverse tunnel its MCP servers reach the gateway through, plus a `-L` forward on the gateway's loopback for the server's API. Turns, aborts and health checks all go through that forward, so a turn needs no ssh of its own. The terminal view runs `opencode attach` over its own ssh on that host, with no tunnel. The password is written to the session's 0600 env file and never appears on a command line. The server's pid is recorded (`tmp/opencode-server.pid`) so a deliberate stop can end the server and its tools. A dropped link also hangs the server up, because it has a tty.

**Resources.** A warm server is a full opencode process: about 650 MB RSS on build-host (opencode 1.18.31), plus its MCP servers. An attached terminal adds about 310 MB while it's open. Idle servers are limited per host (`maxIdle` / `maxIdleByHost`) and by age (`idleTtlMs`), and they count toward `engines.claude.maxLivePtys`, the gateway-wide idle cap every interactive engine shares. A server that is serving a turn or is attached to a terminal is never counted or reaped. A terminal is closed 60 seconds after the last browser socket on it goes away.

**Switching back** to `mode: run` stops every warm server before the next turn runs as a plain `opencode run`, so two processes never write one session.

---

## Model discovery

`opencode models` prints one `provider/model` per line — every model the installed CLI can actually reach. Jinn refreshes this on the background timer and on `POST /api/engines/refresh`.

The catalog exists **only** once discovery has run: opencode ships no offline list, and what it reports depends entirely on which providers the operator configured on that machine. So an unrecognised model id is allowed through with a warning rather than refused — the same treatment Pi gets — because refusing it would reject an employee's own configured model for reasons that have nothing to do with the model.

---

## Known limits

- The terminal view exists only in server mode. In the default `run` mode there is no `/ws/pty` terminal for an opencode session.
- **Prompts that bypass Jinn are not copied into the Jinn chat.** Since the desktop terminal is interactive, so a prompt typed into opencode's own input box in the CLI view is one of these, alongside a programmatic `/ws/pty` `stdin` client and direct calls to the password-protected server API. It runs in the opencode session and shows in opencode's history and in the TUI, and the next Jinn turn's context includes it (it is the same opencode session), but the Jinn chat does not show it. Anything sent through the composer is in the transcript. Accepted as D5 and again.
- If a turn has to replace the server (see above) while an operator's own prompt is running in the terminal, that prompt is cut off.
- No effort/`--variant` support (see Configuration above).
- No quota reading from the provider. Unless `usageLimits` is configured (see Usage limits above), `jinn limits` lists opencode as unsupported. When it is configured, the reading is jinn's own estimate from its turn ledger, not the provider's account.
- Attachments are named in the prompt text on a local turn and refused outright on a remote one. opencode's own `-f` flag is not wired up yet — Pi behaves the same way.
