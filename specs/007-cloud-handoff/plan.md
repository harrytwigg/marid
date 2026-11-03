# Implementation Plan: Cloud Handoff

**Branch**: `docs/cloud-handoff-spec` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md and research.md. The design below is for the reduced version the spec
recommends. It assumes Q2 is **A** (routine fire). Nothing is built until Q1 is answered and,
for option C, until the Phase 0 spike passes.

## Summary

A new engine, `claude-cloud`, is registered only when `cloudHandoff.enabled` is true and the
block validates. A turn on it does four things:

1. Opens a handoff record with a random nonce.
2. POSTs one fire to the target's routine, with a brief that tells the cloud session which
   branch to push and how to report its result in the PR body.
3. Waits on a gateway-side watcher, which polls GitHub's REST API for that branch's PR and
   reads a nonce-tagged result block from it.
4. Resolves with a normal `EngineResult`, so settle, the parent callback, the Todo run and
   the reconcile all work as they do for any engine.

Stop abandons the wait honestly. A restart re-attaches the wait without firing again.

## Existing infrastructure (constitution VII)

The full table is in `research.md` ("What already exists"), verified at `53e47059`. These are
the rows the design leans on:

| `path:line` | Used for |
| --- | --- |
| `packages/jinn/src/shared/types.ts:110` | `Engine.run`, the only contract the adapter must meet |
| `packages/jinn/src/shared/types.ts:115` | `InterruptibleEngine`: `kill` (abandon) and `isAlive` (open handoff) |
| `packages/jinn/src/gateway/server.ts:735` | The engine map. Registration is conditional on the config |
| `packages/jinn/src/mcp/delegation-tools.ts:108` | `engine` is a free string. Selection needs no schema change |
| `packages/jinn/src/sessions/session-patch.ts:50` | An unregistered engine is refused, which is what makes the feature off by default |
| `packages/jinn/src/sessions/turn/scoped-turn.ts:15` | Scoped sessions run `claude` only. FR-009 needs no new code |
| `packages/jinn/src/sessions/callbacks.ts:112` | Parent callback. Reused unchanged |
| `packages/jinn/src/gateway/status-reconciler.ts:21` | The 45 s stale rule the adapter must satisfy through `isAlive` |
| `packages/jinn/src/sessions/restart-resume.ts:451` | Restart nudges. Gains a skip for sessions with an open handoff |
| `packages/jinn/src/shared/env-ref.ts:17` | `${VAR}` resolution for both tokens |
| `packages/jinn/src/shared/remote-mcp-config.ts:100` | The validator pattern `cloud-handoff-config.ts` copies |
| `packages/jinn/src/shared/config.ts:37` | `validateConfigShape`, where the validator is hooked in |

## Technical context

- TypeScript in `packages/jinn`, running on Node 24. SQLite through `better-sqlite3`, as
  the rest of the gateway uses.
- HTTP uses Node's `fetch`, injected so tests can swap it. There is no new dependency.
- No new MCP tool, and no change to any tool schema.
- **Size ratchet.** The new logic goes in new modules under
  `packages/jinn/src/engines/cloud-handoff/` and `packages/jinn/src/shared/`.
  `gateway/server.ts`, `gateway/api.ts` and `sessions/registry.ts` grow by registration
  lines only.

## Design decisions

### D1. An engine adapter, not a new kind of session or tool

`claude-cloud` is an `Engine`. That one choice brings in, unchanged, the following:

- the selection precedence (delegation, Todo override, employee YAML);
- the scoped-department refusal;
- the parent callback;
- the Todo run ledger and reconcile;
- stop;
- the rate-limit wait path for a `429` fire.

**Rejected:**

- **A `hand_off_to_cloud` MCP tool.** That is rung 5. The manifest is close to its ceiling
  (`tool-manifest-budget.test.ts`), and the tool would duplicate delegation.
- **A plugin with its own route and watcher.** It would have no session or Todo integration,
  so it would need a second callback path.
- **A Managed Agents engine.** It is API-billed (research R9), which is not the motivation.

### D2. Creation through the routine fire endpoint

It is the only documented unattended entry point for Anthropic-hosted compute (R2.1). Its
token is scoped to one routine and is not tied to the 30-day OAuth grant (R3, R6).

The adapter POSTs to the configured `fireUrl` with
`Authorization: Bearer <token>`, `anthropic-version: 2023-06-01` and
`{"text": <brief>}`. It reads `claude_code_session_id` and `claude_code_session_url` from
the `200` answer.

**Rejected:**

- **Driving interactive `claude --cloud` in a PTY.** It means scraping undocumented terminal
  output, and it needs the 30-day login.
- **Headless `-p --cloud "<task>"`.** The docs say it is refused (R2).
- **OAuth `-p --environment`.** It waits on S2 and is kept as Q2 option B.

### D3. Documented endpoints only

The CLI's own routine tooling calls unpublished `/v1/code/...` endpoints with the user's
OAuth token (R4). The adapter must not. They can change without notice, and the gateway
would be holding a human's OAuth token to call them. FR-013 makes this a requirement, and a
test pins the allowed hosts and paths of the injected `fetch`.

### D4. The cloud session gets none of the gateway's tools

The paths that exist would each hand too much to a VM that reads untrusted content:

- **`/api` with the gateway bearer** carries operator-level authority.
- **`/mcp`** accepts only a Cloudflare Access assertion with an allow-listed email
  (`src/gateway/remote-mcp/http.ts:217`). A service token has no email, and adding an
  exception widens the operator's own door.
- **A new per-handoff capability on a public endpoint** is a new public auth surface, and
  a rung-4 feature does not justify one.

So the cloud session reports only through GitHub, and everything the ledger needs is
written by the gateway on its behalf.

### D5. The turn waits, and a watcher does the polling

`run()` opens the record, fires, and then awaits a promise registered with a single
`CloudHandoffWatcher`, keyed by handoff id.

The watcher:

- keeps a per-handoff next-poll time. It is one interval timer, not one timer per handoff;
- calls `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`;
- parses the block from the PR body;
- falls back to `GET /repos/{owner}/{repo}/commits/{branch}` for the trailer;
- settles the promise.

While the promise is pending, `isAlive(sessionId)` is true, so the reconciler leaves the
session `running`, and the heartbeat keeps ticking.

**Restart.** At boot, before restart-resume runs, the watcher lists open handoffs.

- For each one whose session exists, it adds the session to a skip set that restart-resume
  consults (FR-017). It then enqueues a turn tagged `cloud-handoff-reattach`, whose `run()`
  finds the open handoff for that session and only awaits it.
- If the session no longer exists, the handoff is marked `abandoned`.
- If a result is found while no turn is attached (a narrow window during boot), it is
  delivered through `notifyParentOfExternalTurn` (`src/sessions/callbacks.ts:153`), the
  existing late-reply path.

**Rejected:**

- **Polling inside `run()` with no persistent record.** A restart would lose the handoff,
  and the nudge would fire a second cloud session.
- **A watcher that settles sessions directly.** That is a second settle path beside
  `settleTurn`.

### D6. What the result looks like

`EngineResult` carries:

- `sessionId`: the cloud session id, filed in the session's engine-session slot.
- `cost: 0`.
- One notice: "cloud usage is billed to the routine owner's plan and is not metered here".
- `result`: a fixed template. It holds the state, the PR URL, the branch and the cloud
  session URL, then the clipped summary inside a block that says it was written by the cloud
  session and is data.
- `error`: set for `blocked`, `failed` and `timed-out`, so the receipt is `failed` and the
  Todo derives `blocked`.

### D7. Count caps are the ceiling

Subscription usage cannot be read per session (R7), so USD budgets cannot bound a handoff.
`maxConcurrent` and `maxPerDay` are checked in one SQLite transaction with the record's
insert, before any outbound call (FR-014). The defaults are deliberately low.

### D8. Config is YAML-only in Phase 1

The `cloudHandoff` top-level key joins `CONFIG_TOP_LEVEL_KEYS`. There is no settings UI.
That matches `remote` and `gateway.remoteMcp`, and `AGENTS.md` asks for no UI toggle
without a consumer. The doctor and `/api/engines` are the visibility (FR-019).

### D9. The engine tables

`claude-cloud` joins:

- `ENGINE_NAMES`;
- the model registry, with one pseudo-model `routine`;
- the rate-limit labels.

It does **not** join `PTY_VIEW_ENGINE_NAMES` (there is no terminal), `REMOTE_ENGINE_NAMES`,
`DYNAMIC_CATALOG_ENGINES` or `MCP_CAPABLE_ENGINES`. The fallback-chain validator refuses it
by name (FR-010).

T013 audits every consumer of `ENGINE_NAMES`, so that a UI list or a health table does not
start offering a cloud engine that is not registered. The rule is that "known" and
"available" stay distinct.

## Rollout phases

| Phase | What | Gate to enter | Effort |
| --- | --- | --- | --- |
| **0. Spike** | The operator creates one routine on a throwaway public repository, with no connectors. A scratch script (kept out of the repository) fires it three times with the brief from `contracts/handoff-brief.md`, then polls GitHub. Answers S1 to S7 in `research.md` | Q1 = B or C | About half a day |
| **1. MVP** | FR-001 to FR-019, behind the flag. Operator guide `docs/cloud-handoff.md` | The spike passes: S1 yes, and S3 or the trailer fallback works | 3 to 5 days, senior |
| **2. Ledger and attribution** | Fill `summary` and `handoff` on the Todo run from the result. `account:` attribution and a rate-limit guard if S5 says the usage reading sees cloud sessions. A PR author check. OAuth follow-ups into a live cloud session if Q2 = B | Phase 1 in use | 2 to 3 days |
| **3. Rung 2** | The board walk may choose `claude-cloud` when local capacity is spent and the cloud's capacity is separately measurable | A capacity reading the system can trust. Not planned | n/a |

## Risks

| Id | Risk | Mitigation |
| --- | --- | --- |
| K1 | The fire endpoint is experimental and changes shape | The adapter is one small module. A contract test is pinned to the documented shape. A changed answer fails the turn loudly and never retries silently |
| K2 | The cloud session ignores the output contract | A timeout that reports any PR it saw. Spike S1 measures it before any build |
| K3 | The routine is edited to attach connectors | The token cannot read the routine, so this is unverifiable. The guide and the doctor say so. This is the main reason the operator creates and owns routines by hand |
| K4 | Cloud work spends the same plan limits, and local sessions on that account hit limits sooner | Low default caps. Phase 2 adds attribution if S5 allows |
| K5 | A forged PR on a handoff branch supplies a fake result | A 96-bit nonce, never published before the fire. The block must carry the nonce. A PR author check in Phase 2 |
| K6 | A retried fire creates duplicate cloud sessions | No automatic retry of an unconfirmed fire (FR-015) |
| K7 | Stop cannot stop the cloud session | The result says so, with the link. The caps bound the damage |
| K8 | The motivation, free credit, ends on 2026-11-04 | The spec's recommendation is to defer |
| K9 | Task text is retained by Anthropic | Q4. The brief carries only task text and the operator's preamble (FR-007) |
| K10 | An hours-long turn holds the session's queue | Accepted. Follow-ups queue, and FR-018 picks them up as a new handoff |
| K11 | Todo recovery's 4 h rule treats a long handoff as stalled | Checked: no. Both checks skip a Todo whose open run has an in-flight session (`src/work-items/recovery.ts:169` and `src/work-items/anomaly-detect.ts:39`). A child counts as in flight while its `lastActivity` is under 4 h old (`src/work-items/open-delegations.ts:49`), and the heartbeat keeps that fresh for as long as `run()` is pending. T034 pins this with a test |

## Constitution check

- **I. Fork only.** Nothing goes upstream.
- **II. Rung 4, and why it stops there.** See the spec. The count caps are the stated
  ceiling, and stop plus `enabled: false` are the operator's stop.
- **III. Verify the premise.** The facts are cited at `53e47059`. Platform behaviour that is
  not documented is listed as S1 to S7 and must be answered by the spike before Phase 1.
- **IV. Footprint Ladder.** Rung 1: it extends the engine registry and an existing free
  string. There is no manifest change, and SC-006 pins that.
- **V. No speculative infrastructure.** Every config key has a consumer in Phase 1.
  `account:`, follow-ups and a settings UI are deferred until a consumer exists.
- **VI. Tests that can fail.**
  - Fake routine and GitHub servers on loopback, with an injected clock for timeouts and
    caps.
  - A red test for "feature off means no outbound call". It is written against a build with
    registration forced on, then reverted.
- **VII. A `file:line` table.** Above, and in `research.md`.
- **VIII. Comments explain why.** The adapter's comments cite the docs section each
  behaviour depends on.

## Complexity tracking

| Addition | Why it is needed | Simpler alternative rejected because |
| --- | --- | --- |
| A persistent handoff table | Restart must not fire twice (FR-017, SC-003) | In-memory state loses the handoff at restart |
| A watcher with one timer | Many open handoffs must not mean many timers, and boot re-attach needs one owner | Per-turn polling cannot survive a restart |
| A restart-resume skip set | Nudge text must not become a second fire | Disabling nudges globally changes every other session |
