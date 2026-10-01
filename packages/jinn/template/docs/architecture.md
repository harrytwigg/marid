# Architecture

{{portalName}} runs as a single Node.js process acting as a gateway between external connectors and AI engines.

## Components

```
┌─────────────────────────────────────────────────┐
│              {{portalName}} Gateway                │
│                                                  │
│  ┌───────────┐  ┌────────────┐  ┌────────────┐  │
│  │ HTTP Server│  │ WebSocket  │  │   Cron     │  │
│  │ REST + UI  │  │  Server    │  │ Scheduler  │  │
│  └─────┬─────┘  └─────┬──────┘  └─────┬──────┘  │
│        │               │               │         │
│  ┌─────┴───────────────┴───────────────┴──────┐  │
│  │            Session Manager                  │  │
│  │  Routes messages, manages engine lifecycle  │  │
│  └─────────────────┬──────────────────────────┘  │
│                    │                              │
│  ┌─────────────────┴──────────────────────────┐  │
│  │              Engine Adapters                │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ Connector  │  │   File     │  │  SQLite   │  │
│  │  System    │  │  Watcher   │  │  Registry │  │
│  └────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────┘
```

### HTTP Server
REST API for session management, configuration, and health checks. Also serves the static web UI.

### WebSocket Server
Pushes live events (session updates, engine output, cron results) to connected clients.

### Session Manager
Central router. Receives messages from connectors, resolves the target employee and engine, creates or reuses sessions, and delivers responses back through the originating connector.

### Engine Abstraction
Uniform adapters support the canonical engines: claude, codex, antigravity, grok, pi, hermes, opencode. Each adapter owns its engine-specific session and tool integration while the gateway keeps routing uniform.

### Connector System
Modular adapters that implement a standard interface. Each connector translates between its platform's message format and {{portalName}}'s internal message format. See `connectors.md`.

### Cron Scheduler
Uses `node-cron` to run scheduled AI jobs. Watches `cron/jobs.json` for hot-reload. See `cron.md`.

### File Watcher
Uses `chokidar` to watch parts of `~/.jinn/` and trigger appropriate reloads:
- `config.yaml` changes → re-read the configuration in memory (see `self-modification.md` for what a reload does not apply)
- `cron/jobs.json` changes → reschedule cron jobs
- `org/` changes → rebuild employee registry
- `skills/` (top level only) → a skill folder added or removed re-syncs the `.claude/skills/` and `.agents/skills/` links and notifies clients
- `plugins/` → rescan installed plugins

### SQLite Session Registry
Stores session metadata (id, engine, employee, connector source, timestamps) in `sessions/registry.db`.

### Restart record
A gateway restart interrupts every running session. The outgoing gateway marks each one `interrupted`, and the next boot nudges each of them to continue (up to a cap, staggered) unless `gateway.resumeInterruptedSessions: false`. Two kinds of session that were not running are nudged too, each with its own message, because the restart killed what they were waiting on:

- **The session that asked for the restart** (`jinn restart` from a session sends `X-Jinn-Session-Id`, including from a script it launched). The next boot posts "Gateway restarted successfully." in it and nudges it — requesters go first, ahead of the cap. It is held to the notice alone if it has already been nudged back from two of its own restarts in the last 30 minutes (the restart-loop guard: a redeploy after a failed verify is still nudged, a third restart in a row is not), or if its request is more than 30 minutes old (a restart that never ran — such an acknowledgement is ignored at shutdown too). A requester that a pending queue item re-drives resumes through that item instead.
- **An idle session still waiting on background work** (stored `idle` only; a session paused on a rate limit is mid-turn) — a background Bash task or background sub-agent the engine has not seen finish, a background re-run in progress, or a background agent with a request in flight. Its engine process dies with the gateway, so the task's completion notification never arrives. While its sub-agents or re-run are live, such a session is reported `running` to every reader (the session list, `list_sessions`, `read_session`, Todo recovery) and its `lastActivity` follows that work; its stored status stays `idle`.

Both halves are written to `sessions/restart-interrupted.jsonl`, one JSON line per session per event, so the set survives the boot that consumes the marks:

- `{"event":"interrupted", "cause":"shutdown"|"stale-on-boot", "resume":"restart-resume"|"restart-notice"|"workflow-runtime", ...}` — written by the gateway that found the session running, idle but waiting (`detail` says on what), or waiting on its own restart request, with its `bootId`, the session id, employee, engine, Todo and title. `shutdown` is the outgoing gateway recording it (it leaves a receipt in the registry's `meta` table); `stale-on-boot` is the next boot finding a row still `running` that the old gateway did not record — no receipt, i.e. the old process was killed or crashed, or (with a receipt) a conversational turn that started during the shutdown drain.
- `{"event":"resume", "outcome":"nudged"|"queue-replay"|"deferred"|"disabled"|"no-attempt-token"|"already-nudged"|"already-delivered"|"loop-guard"|"stale", ...}` — written by the new gateway for every conversational session it took over, with its own `bootId`. A `nudged` line's `detail` carries the delivery id, followed by `(requested)` or `(background)` when the session was not caught mid-turn.

`grep <session id> sessions/restart-interrupted.jsonl` answers "was this session running at the restart, and what happened to it". `restart-resume` and `restart-notice` entries get a `resume` line; one with no `resume` line, or with an outcome other than `nudged` or `queue-replay`, was left for the operator. `workflow-runtime` (an attempt the workflow runtime re-dispatches) is handled without one. The file rotates once to `.1` at 1 MiB.

## Data Flow

1. Connector receives an external message (e.g., Slack message)
2. Connector normalizes the message and calls session manager
3. Session manager resolves the target employee and engine
4. Session manager creates or reuses a session for the source reference
5. The selected engine adapter processes the message
6. Engine streams or returns the result
7. Session manager delivers the result back through the originating connector
8. WebSocket server broadcasts the event to any connected web UI clients
