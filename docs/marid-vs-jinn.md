# Marid vs upstream Jinn

Marid is a fork of [Jinn](https://github.com/hristo2612/jinn) by hristo2612 and contributors, released under the MIT License. Most of the code here is theirs: the gateway, the org model, Todos, the web dashboard and most of the engine adapters. Marid keeps the internal codename ("Jinn": the `jinn` command, `jinn-cli`, `~/.jinn`, `JINN_*`) so upstream fixes can still be merged. See [`NOTICE`](../NOTICE) and the [README](../README.md#built-on-jinn).

This page lists the headline features Marid has that upstream does not, and is just as plain about where upstream already has the feature. It is not an exhaustive changelog; smaller fixes and hardening are in [`CHANGELOG.md`](../CHANGELOG.md).

**Compared:** Marid `main` (built on upstream v0.33.3) against upstream Jinn `main` at v0.33.4. Upstream's v0.33.4 fixes are not in Marid yet. Every row was checked against the code on both sides.

**Key:** ✅ supported. ❌ not present. partial = some of it exists; the Notes column says which part.

## Workspace UI

| Feature | Marid | Jinn upstream | Notes |
|---|---|---|---|
| Multi-chat grid with drag-to-place | ✅ | ✅ | Upstream lays chats out on an auto grid and lets you drop a chat on the left, right, top or bottom of a pane. Marid keeps that grid until you first split or resize, so an unarranged workspace behaves as upstream. |
| VS Code-style split panes | ✅ | partial | Marid's layout is a tree of row and column splits (`routes/chat/layout/split-layout.ts`, `split-chat-grid.tsx`). Upstream computes columns and rows from the pane count and viewport (`grid-layout.ts`); you cannot choose the split. |
| Drag a chat from the sidebar to split | ✅ | partial | Both accept a sidebar drag onto the workspace. In Marid the drop creates the split you aimed at (`split-drop.ts`, with a live preview). In upstream it adds the chat to the auto grid. |
| Resizable splitters | ✅ | ❌ | Drag, arrow keys (Shift for bigger steps, Home/End for the limits) and double-click to reset to equal shares (`split-handle.tsx`). Layout is stored in the browser (`jinn-chat-split-layout`). |
| Per-pane tab strip | ✅ | partial | Marid gives every pane its own tab strip, and tabs drag between panes and reorder (`pane-tab-strip.tsx`, `pane-tab-dnd.ts`). Upstream keeps one tab list (`hooks/use-chat-tabs.ts`) that drives keyboard tab switching, and shows header pills rather than a tab strip. |
| Preview and pinned tabs | ✅ | partial | Marid: a tab opened by ordinary navigation is an italic preview tab that the next open replaces; double-click pins it. Upstream's tab model has the same pinned/preview rule but no visible strip to show it. |
| Mobile session tabs | ✅ | partial | Marid replaces the phone's chat strip with tabs that have close buttons (`mobile-session-tabs.tsx`). Upstream has a strip of working-set chips whose preview text is screen-reader only (`mobile-working-set-nav.tsx`). |
| Shift-click range select in the chat list | ✅ | ❌ | Upstream already has multi-select and bulk delete. Marid adds range select. |
| Teal Marid theme and name | ✅ | ❌ | A token-override file (`routes/theme-overrides.css`) and a single product-name constant (`lib/brand.ts`). A colour the user picks still wins over the default. |

## Terminal and CLI mode

| Feature | Marid | Jinn upstream | Notes |
|---|---|---|---|
| CLI view of the engine's TUI | ✅ | ✅ | Both stream the engine's terminal into the chat pane, with a composer and a key bar. |
| Warm PTY sessions | ✅ | ✅ | Upstream feature (`hasWarmPty` in the PTY socket and the Claude engine). Marid did not add it. |
| Type straight into the engine's TUI (stdin) | ✅ | ❌ | On desktop, keystrokes, paste, mouse and wheel go to the PTY as `input` frames, up to 64 KiB (`pty-ws.ts`, `lib/terminal-input.ts`). Upstream's browser terminal is display-only (`disableStdin: true`) and never sends raw keystrokes; only the composer and a short list of keys reach the engine. Touch devices keep the display-only view in both. |
| Faster scrollback, clickable URLs, opencode scrolling | ✅ | ❌ | Wheel scrolls Claude's scrollback about twice as fast, Shift+PageUp/PageDown work, links are clickable. On touch, a swipe over opencode becomes wheel reports. |
| Wait for a turn typed in the terminal | ✅ | ❌ | A gateway turn that arrives while a turn you typed is running waits, shown as a "waiting for the turn typed in the terminal" status with a Stop button. Otherwise the typed turn's answer could be recorded as the gateway turn's reply. |
| Standalone terminals in the sidebar | ✅ | ❌ | A shell on the gateway or on any configured host (`terminal.hosts`, plus each employee's `remoteHost`). Terminals sit in the chat grid beside chats, reattach with their last screen, and are operator-only. On by default; `terminal.enabled: false` turns them off. See [`terminals.md`](terminals.md). |

## Engines

| Feature | Marid | Jinn upstream | Notes |
|---|---|---|---|
| Claude, Codex, Grok, Hermes, Antigravity, Pi | ✅ | ✅ | Same adapters. |
| opencode engine | ✅ | ❌ | `engines/opencode*.ts`; models are in the model registry. Local or on a remote host. See [`engines-opencode.md`](engines-opencode.md). |
| opencode server mode with live terminal | ✅ | ❌ | `engines.opencode.mode: server` gives each session its own password-protected `opencode serve`. The CLI toggle opens opencode's TUI as an `opencode attach` client on it. The default `mode: run` spawns per turn. |
| opencode usage limits | ✅ | ❌ | opencode publishes no quota, so Marid meters spend from its own per-turn ledger (`shared/engine-limits-opencode.ts`, `sessions/engine-spend.ts`) and shows it beside the other engines' limits. Upstream's limits page covers its own engines only. |

## Remote

| Feature | Marid | Jinn upstream | Notes |
|---|---|---|---|
| Employees on a remote host over SSH (Claude) | ✅ | ❌ | An employee with `remoteHost` runs its turns on another machine; repositories, builds and tests stay there. Needs a `remote` block in `config.yaml` and fails closed without one. Manage with `jinn remote status\|wake`. See [`remote-execution.md`](remote-execution.md). |
| Remote Pi employees | ✅ | ❌ | Pi runs headless over `ssh -T` and streams normally. Claude loses token-by-token streaming remotely. |
| Remote opencode employees | ✅ | ❌ | Both run and server mode. |
| Interrupt stops the remote process | ✅ | ❌ | The remote command records the agent's pid, and an interrupt, timeout or shutdown kills it and its children before the turn settles (`engines/remote-stage.ts`). |
| Other engines on a remote host | ❌ | ❌ | Codex, Grok, Hermes and Antigravity ignore `remoteHost`; Marid refuses those turns rather than run them locally. |
| Remote MCP connector | ✅ | ❌ | Opt-in. Serves a subset of the tools at `/mcp` behind Cloudflare Access so claude.ai, Claude Desktop and Claude Code can use the instance as a custom connector. It holds no approval authority. See [`remote-mcp.md`](remote-mcp.md). |

## Sessions

| Feature | Marid | Jinn upstream | Notes |
|---|---|---|---|
| Self-compaction | ✅ | ❌ | The `compact_session` MCP tool lets an agent compact its own context and carry on from a handoff (`sessions/self-compaction.ts`). Claude, and opencode in server mode. |
| `/compact` from the chat | ✅ | partial | Upstream recognises Claude Code's own `/compact` typed to a Claude session. Marid routes `/compact` per engine (Claude's native command, opencode's summarize) from the web chat, the CLI composer or a connector, and says so when an engine cannot. |
| Auto-compaction of cold sessions | ✅ (opt-in) | ❌ | With `engines.<claude\|opencode>.autoCompact.enabled`, a long session idle past its engine's prompt-cache window is compacted before its next turn runs, so that turn and the ones after it don't re-read the whole context at full price (`sessions/turn/auto-compact.ts`, [`auto-compaction.md`](auto-compaction.md)). |
| Restart resume | ✅ | partial | Upstream nudges sessions that were mid-turn (`sessions/restart-resume.ts`). Marid also nudges the session that asked for the restart and sessions idle on background work, and writes a record of every interrupted session and what the next boot did (`sessions/restart-interrupted.jsonl`). |
| Claude auth outage handling | ✅ | partial | Marid tracks an outage per host, alerts once, refuses launches that cannot work, prefers a fallback engine and warns 48 hours before the refresh token expires. See [`claude-auth.md`](claude-auth.md). Upstream classifies the auth failure but has none of that. |
| Browser-origin check on the live event socket | ✅ | partial | Upstream has no origin rejection on any socket; on `/ws/pty` it only trusts a same-origin browser as the operator when gateway auth is off. Marid rejects a cross-origin browser on `/ws`, plugin event sockets and `/ws/pty`. Behind a reverse proxy, preserve `Host` or send `X-Forwarded-Host`. |
| File-read policy for uploads | ✅ | ❌ | One policy shared by the gateway and the MCP server keeps `secrets/` and other protected files out of ingestion, including for sessions on a remote host (`shared/file-read-policy.ts`). |

## Todos and dispatch

| Feature | Marid | Jinn upstream | Notes |
|---|---|---|---|
| Closed Todo departments | ✅ | ❌ | `gateway.todoDepartments` makes the department list one the operator owns. Unset, any name still becomes a department, as upstream. |
| Board walk | ✅ | ❌ | On by default, ruled by `board-walk.md`. A scheduled model pass releases Todos whose gates are met (dates, blockers, merged PRs), parks date gates, flags stuck Todos once, and starts ready backlog work when spare capacity would otherwise lapse. See [`idle-capacity.md`](idle-capacity.md). |
| Auto-Dispatch dashboard page | ✅ | ❌ | `/auto-dispatch`: policy editing, next-tick preview, start history and a usage chart. |
| Per-Todo auto-start opt-out | ✅ | ❌ | `autoStart` in a Todo's dispatch config, and the `no-auto-start` label. |
| Session tree on a Todo | ✅ | ❌ | The Details rail lists the sessions working the Todo, with their delegations underneath, and every session links to its chat. |
| Parked Todos come back on their own | ✅ | partial | Upstream can park a Todo until a date but nothing releases it. Marid's reconciler moves an expired park back to `backlog`, keeping its owner. |
| Flag Todos left in `executing` with no one on them | ✅ | partial | Upstream flags an executing Todo whose open run has outlived four hours with nothing in flight (`execution-timeout`). Marid also flags one with no open run at all and nothing running for over four hours (`executing-unhanded`, `work-items/anomaly-detect.ts`, `recovery.ts`), so it does not sit in the column unseen. |
