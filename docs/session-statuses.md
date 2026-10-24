# Session statuses

Every session has one stored `status` — `Session["status"]` in `packages/jinn/src/shared/types.ts` — with five values: `idle`, `running`, `error`, `waiting` and `interrupted`. It is what the session list, the session API and the MCP session tools report, and what the web UI paints as a dot.

## The five statuses

| Status | What it means | Who sets it | In the web UI |
|---|---|---|---|
| `running` | A turn is in flight. | The turn path when it starts a turn, including a usage-limit retry (reported as `waiting` until the retry streams output, see below). | Blue pulsing dot. |
| `waiting` | Paused: not working, not failed, and not waiting for a person. | The usage-limit wait (`sessions/rate-limit-handler.ts`) or the remote-host gate (`sessions/turn/remote-ready.ts`). | Amber still dot; its tooltip carries `lastError`. |
| `error` | The last attempt failed. | The turn path when an engine fails. | Red dot for 24 hours after the last activity, then none. |
| `idle` | Nothing is in flight. | The turn path when a turn settles, and `stop`. | No status dot (an unread idle chat shows the neutral unread dot). |
| `interrupted` | A turn was stopped rather than finished. | Stop, reset, and the restart that interrupted a turn. | No status dot. |

## Waiting

A session is `waiting` for one of two reasons.

- **A usage limit.** The engine reported a limit and no fallback chain entry could serve the turn, so the session sleeps until the limit's reset time and retries on its own engine. When the limit names no reset time it retries on a back-off instead. `lastError` reads like `Claude usage limit — resumes <ISO time>` or `Claude usage limit — waiting for reset`. While it waits, `lastActivity` is refreshed every 60 seconds, so the session never reads as abandoned. See [fallback chains](fallback-chains.md).
- **A remote host that is not ready.** A remote employee's turn waits for the host to wake, or for its instance-home mount to appear, and `lastError` says which: `<host> is offline — waking it` or `<host> is up — waiting for the instance-home mount`. See [remote execution](remote-execution.md#when-the-host-is-off).

The sidebar, the chat title bar, the mobile session rows, the pane tabs and the search results paint the wait as an amber, still dot — not the blue of a working session and not the red of a failure — and the dot's tooltip is `lastError`. On a Todo's page the session list, the session tree and the status chip read "Waiting" in amber instead of "Working" in blue.

`waiting` never means "waiting for a person": a turn that needs an answer ends and the session goes `idle`. This status is only the machine-side wait, which is why a new message, a stop or the limit passing are all it takes to end one.

### A retry that has shown no output is still a wait

Each time the wait is up the gateway retries the turn on the limited engine. While the limit is still up that retry can hang for many minutes before it fails, so its stored status is `running` (stopping the session must still reach the engine) but the session is *reported* as `waiting` — by the API, the MCP tools and the UI alike — until the retry streams its first text or tool output. Only then does it read `running`. If the retry fails with the limit still in place the session goes back to a plain `waiting`.

### How the wait ends

- **The limit lifts.** The retry runs and the status returns to `running`.
- **A substitute's window ends.** A session parked on a stand-in Claude account goes back to its own account and engine at the window's end (`sessions/rate-limit-handback.ts`).
- **A new message arrives.** Sending a message is an explicit "retry now": the session goes to `idle`, which unwinds the wait, and the message runs at once. Child-completion notifications do not do this.
- **The session is stopped.** Stop ends the wait; the session stays `idle`.

### It is not a stall and not a failure

`waiting` is live. These readers count it as in flight, so a paused session is never reported as stalled, dead or failed:

- the quiet-Todo nudge (`work-items/quiet-watch.ts`);
- the Todo reconciler, which leaves a Todo with a waiting session in `executing` (`work-items/reconcile.ts`);
- the open-delegation check behind child-settle wake-ups (`work-items/open-delegations.ts`);
- the board walk and the Todo Dispatcher;
- `GET /api/sessions` and `GET /api/sessions/:id`;
- the MCP session tools and the web UI.

### Reading it over the API

`GET /api/sessions` (every session, or one group's page) and `GET /api/sessions/:id` (one session) both return `status` and `lastError` on each row:

```json
{ "id": "…", "status": "waiting", "lastError": "Claude usage limit — resumes 2026-10-24T16:00:00.000Z" }
```

A usage-limit wait refreshes `lastActivity` every 60 seconds, which is how the row stays visibly alive in a list sorted by activity.

### Reading it over MCP

- `search_sessions { "status": "waiting" }` lists the sessions paused on a wait; `status` takes any of the five values. It returns the compact row (id, title, employee, engine, status, lastActivity, parent session), so read the reason with `read_session`.
- `read_session { "sessionId": "…" }` returns `status`, `lastError` and a next-step `hint` — for a waiting session, "Waiting on limit. Next: no action."
- `list_sessions` returns `status` on each row but takes no status filter.
