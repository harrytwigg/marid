# Implementation Plan: Auto-Dispatch Dashboard

**Branch**: `feat/gen-100-auto-dispatch-ui` | **Date**: 2026-09-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-auto-dispatch-ui/spec.md`

## Existing Infrastructure *(Principle VII — opens the plan)*

Verified against the worktree on the date above at `origin/main` a83a47db (PR #17 merged).
**References rot — re-verify before handover.**

### What this plan uses

| `path:line` | What it is | How this plan uses it |
| --- | --- | --- |
| `packages/jinn/src/shared/idle-capacity-config.ts:61` | `IDLE_CAPACITY_DEFAULTS` — the policy with every key explicit | The shape the form edits; the page never holds a default of its own. |
| `packages/jinn/src/shared/idle-capacity-config.ts:134` | `resolveIdleCapacityPolicy` — file block → policy, defaults filled | Already run by the preview (`:220` below), which is how the form gets resolved values. |
| `packages/jinn/src/shared/idle-capacity-config.ts:253` | `idleCapacityProblems` — the validator; every message begins `gateway.idleCapacity.<path> …` | **The only validation.** Runs inside `validateConfigShape` on every PUT (`api.ts:4579`); the page maps each message back to its field by that path prefix. Not copied. |
| `packages/jinn/src/shared/config.ts:71` | `validateConfigShape` wiring of `idleCapacityProblems` | Confirms a bad block never reaches the file from any writer. |
| `packages/jinn/src/gateway/api.ts:4522` | `GET /api/config` — redacted document + `X-Jinn-Config-Revision` | Not called by this page: the policy route stamps the same header the same way (`currentConfigRevision`), so values and revision come from one response. Cited as the precedent the policy route copies. |
| `packages/jinn/src/gateway/api.ts:4530` | `PUT /api/config` — unknown-key check, `isStaleConfigRevision` (`:4546`), deep-merge with the file, `validateConfigShape` (`:4579`), `saveConfigAtomic`, `reloadConfig` (`:4582`) | **The write path, unchanged.** A partial body `{ gateway: { idleCapacity } }` with the revision header. Operator-only via the control-plane table (`api.ts:910`). |
| `packages/jinn/src/gateway/config-payload.ts:98` | `deepMerge` — `null` deletes a key; mappings merge | `requireLabel: null` clears the key; every other key is sent explicit, so merge ≡ replace for the block. |
| `packages/jinn/src/gateway/api.ts:4508` | `GET /api/idle-capacity` — the preview, 503 without a loop; every call runs the collector (`idle-capacity.ts:154`) | **Moves** into the new domain module (below) so `api.ts` shrinks rather than grows. Its body is the page's next-tick summary. It is **not** the form's seed: a new `GET /api/idle-capacity/policy` in the same module returns `resolveIdleCapacityPolicy(config.gateway.idleCapacity)` with the `X-Jinn-Config-Revision` header, no collector call, no loop needed — values and revision in one response. |
| `packages/jinn/src/gateway/config-revision.ts:45` | `isStaleConfigRevision` — a caller with no revision is deliberately untouched | Why the page must never write before it holds one: the write hook's `blocker` refuses until the revision has been adopted. |
| `packages/jinn/src/gateway/idle-capacity-backlog.ts:28` / `:21` | `dispatchReason` skips `autoStart === false`; `labelReason` skips the `no-auto-start` label | **Already wired** (the addendum asked this to be verified before building): the per-Todo switch needs no gateway rule. |
| `packages/jinn/src/gateway/api.ts:3240` | `PUT /api/work-items/:id/dispatch-config` — `{ autoStart: boolean }` accepted; operator, creator or assignee | The switch's write, unchanged. |
| `packages/jinn/src/gateway/work-item-payload.ts:136` | The detail payload carries `dispatchConfig` | The switch's read; the web wire type does not yet name it. |
| `packages/web/src/routes/todos/task-page/props-rail.tsx:147` | The Dispatch button in the Todo page's rail | The switch sits under it, as its own small component. |
| `packages/jinn/src/gateway/idle-capacity.ts:220` | `preview()` — `policy`, `tier`, `reason`, `verdict`, `skipped`, `eligible`, `startedThisWindow` (`:231`), `operator`, `quietHours` | Rendered as-is; nothing added to it. |
| `packages/jinn/src/gateway/idle-capacity.ts:175` | `recordStart` — builds the system comment from `verdict.reason`, session id, `charged`, `cap` | **Refactored** to format through the new `shared/idle-capacity-record.ts`, which also owns the parser (FR-006). Wording unchanged. |
| `packages/jinn/src/gateway/idle-capacity.ts:52` | `IDLE_CAPACITY_ACTOR = "idle-capacity"` | The history query's author key. |
| `packages/jinn/src/shared/idle-capacity.ts:216` | `evaluateIdleCapacity`'s act reasons: `` `${tier} tier, five-hour window about to lapse: ${summary}` `` and the weekly variant; `summary` is `describe()` joined by `; ` | The grammar the parser reads: tier, trigger, then `<name> <n>% used, resets in <formatMinutes>` per window. |
| `packages/jinn/src/work-items/comment-add.ts:113` | `addComment` — author, kind, body; audit event in the same transaction | Already the writer. Unchanged. |
| `packages/jinn/src/work-items/comments.ts:233` | `listComments(workItemId)` — per-Todo only; `work_item_comments` indexed on `(work_item_id, created_at)` (`work-items/migrate.ts:134`) | Not enough: history is across Todos. A new query by `(author_kind, author)` in a small module; a table scan at this table's size, no index added. |
| `packages/jinn/src/work-items/store.ts:519` | `getWorkItem(id)` — title, status | Joined per row for the Todo's title and current status. |
| `packages/jinn/src/gateway/work-item-kept-api.ts:51` / `route-helpers.ts:1` | The domain-module contract (`handle<Domain>Api` → boolean; `json`/`notFound`) and the smallest example of it | `gateway/idle-capacity-api.ts` follows it: preview (moved), history, usage. One delegation line in `api.ts` where the preview block sat (`:4508`). |
| `packages/jinn/src/shared/engine-limits-claude.ts:232` | `collectClaudeLimits` — the live OAuth path returns `status: "live"` at `:251` | **The one sampling hook**: every reading, whoever asked for it (loop tick, 15-min health refresh, Limits page, `jinn limits`), records a usage sample on the live path. |
| `packages/jinn/src/shared/engine-limits.ts:363` | `recordExhaustedWindows` called from the collector | The precedent for the collector writing durable state as a side effect; the sampler sits one level down, on the Claude collector, because the loop calls that directly. |
| `packages/jinn/src/shared/engine-health-store.ts:48,52,67` | `tmp/engine-health.json` — read/write that swallow their own errors; the write uses a **fixed** `.tmp` name (`:70`) | The storage pattern for the usage history — advisory, bounded — except the temporary name: two writers (gateway and `jinn limits` on the same host; preview, Limits page and loop in-process) can tear a fixed name, so the history uses a per-process name and rename, as `saveConfigAtomic` does (`shared/config.ts:286`). A race loses a sample, never the file. |
| `packages/jinn/src/shared/engine-limits-claude-usage.ts:6,9` | `resetsAt` is undefined when the API reports no reset (an untouched window); `usedPercent` is integer-rounded | A window without a reset is left out of a sample, as `reading()` leaves it out of the verdict (`shared/idle-capacity.ts:102`); the rounding is why a projection needs a minimum span. |
| `packages/jinn/src/gateway/idle-capacity.ts:146` | The guard returns before `deps.collect` (`:154`) while the feature is disabled | So a disabled loop never samples; the 15-minute engine-health refresh (`background-refresh.ts:41`) is what feeds the graph then — enough for a 12 h view and a weekly indication. |
| `packages/jinn/src/work-items/comments.ts:211` | Tombstone clears the body | A deleted start comment is unrecoverable; the exclusion is forced, not chosen. |
| `packages/jinn/src/shared/paths.ts:78` | `ENGINE_LIMITS_DIR` | Where the history file lives. |
| `packages/web/src/routes/settings/use-config-commit.ts:96` | `useConfigCommit` — debounced PUT with revision, adopts the revision a PUT returns (`:67`), conflict → notice; `adoptRevision` (`:117`) drops any queued edit by design | **Reused as-is** for the policy form's writes. `adoptRevision` runs on load and on Reload only, as Settings does (`settings/page.tsx:147`) — never after a save, or a queued edit to the next field is discarded while the pill says Saved. |
| `packages/web/src/routes/settings/config-shape.ts:11` | `Config` — the document the hook PUTs; `gateway` typed `{ port?, host? }` | Extended with `idleCapacity?: IdleCapacityBlock` so the hook takes the partial body without a cast. |
| `packages/web/src/routes/settings/config-save-status.tsx:10` / `config-conflict-notice.tsx:11` | The floating Saved/Failed pill and the conflict notice with Reload | Reused verbatim. |
| `packages/web/src/routes/settings/shared.tsx:5,39,60,118` | `Section`, `FieldRow`, `SettingsInput`, `ToggleSwitch`, `CONTROL_CLASS` | The form's controls, so the page reads as Settings does. |
| `packages/web/src/lib/api-config.ts:35` | `createConfigApi` — `getConfig()` returns `{ config, revision }` | The revision read. |
| `packages/web/src/routes/limits/use-engine-limits.ts:135` | `useEngineLimits` — visibility-paused 60 s refresh, reconnect, in-flight guard, 8 s timeout, display clock; `mergeAuthoritative` is the Limits-specific part | This page is the **second caller** of the same refresh policy, so the policy is extracted (`hooks/use-polled-read.ts`: fetcher, optional merge, the four constants) and both consume it; `useEngineLimits` keeps its merge and its exports (`hooks/use-page-visibility.ts:6`, `hooks/use-gateway.tsx:131` move with it). Its existing test suite is the proof the extraction is faithful. |
| `packages/web/src/lib/app-routes.ts:18` | `APP_ROUTES` — every renderable path | `auto-dispatch` at `/auto-dispatch`, surface `auto-dispatch`. |
| `packages/web/src/lib/nav.ts:52` | `BASE_NAV_ITEMS` — rail order; overflow derived | Inserted after `/limits`. `lib/__tests__/nav.test.ts:39` lists the overflow order and is updated. |
| `packages/web/src/main.tsx:100` | `routeElements` | One lazy route. |
| `packages/web/src/components/talk/context/coverage.ts:31` | `TALK_SURFACE_COVERAGE` — a test fails for any route without an entry, and `docs/talk-control-coverage.md` must start with the rendered table | One `supported(...)` entry; the doc regenerated from `renderTalkCoverageMarkdown`. |
| `packages/web/src/components/global-search/static-pages.tsx:10` / `routes/more/page.tsx:22` | Command-palette pages; More-screen tint | One entry each. |
| `packages/web/src/routes/limits/page.tsx:99` | `WindowBar` — used %, bar, resets-in | The reading style the next-tick card reuses (copied shape, not the component: it is page-local and Limits-typed). |

### What was found and rejected

| `path:line` | What it is | Why not |
| --- | --- | --- |
| A `PUT /api/idle-capacity/policy` route | A dedicated writer for the block | A second config-mutation path is exactly the blast radius the ticket warns about: it would need its own revision check, atomic write and reload, and would drift from `PUT /api/config`. The existing route already does all of it for a partial body. |
| A web-side copy of `idleCapacityProblems` | Instant client validation | The ticket forbids a second copy; the gateway's refusal already names the key, and mapping the message to a field costs one function. HTML `min`/`max`/`type=time` give the cheap instant feedback. |
| `work_item_events` with a new `kind` and JSON `detail` | Structured start records | Would be a second write per start beside the comment, with the two able to disagree; the comment already carries every field the ticket lists. The parser lives with the formatter and is round-trip tested instead (FR-006). |
| A new `idle_capacity_starts` table | Same | Same, plus a migration. |
| Extending the Settings page with a section | Where the operator first looked | Settings is 1395 lines and page-level instant-apply of the whole document; the ticket asks for a destination with a history list and a graph, which is not a settings section. The Settings page gets nothing; the new page reuses its write hook. |
| A tab inside Limits | Adjacent data | Limits is per-engine quota; the operator asked for an Auto-Dispatch tab by name. |
| A sibling hook copying `useEngineLimits`'s refresh policy | Avoiding a change to Limits | Rejected on review: this page is the second caller, and Principle V says extract on the second. The policy is extracted; only the Limits merge stays put. |
| Seeding the form from the preview's `policy` | One fewer route | Rejected on review: the preview needs the loop (503 otherwise), runs the collector on every call (an OAuth round-trip before first paint), and carries no revision — so the form would be editable before `GET /api/config` returned and a write in that gap would carry no revision and bypass the staleness check. The policy route returns values and revision together. |
| Writing only the keys the file already set or the operator changed | A minimal `config.yaml` block | Feasible (the policy route can return the raw block too) and recorded as the alternative in spec Open Decision 1; the whole block is chosen for legibility, not because the merge forces it. |
| A chart library | The graph | `d3-hierarchy` is the only d3 in the bundle; one polyline with markers is inline SVG. |
| Sampling in `gateway/idle-capacity.ts` and `background-refresh.ts` separately | Two hook sites | The loop calls `collectClaudeLimits` directly, so the collector is the one place every reading passes through. |
| Sampling the statusline-snapshot fallback too | More points | Its `refreshedAt` is the snapshot's write time, not the read; points would land out of order and duplicate. Live readings only. |

### The finding that shapes the plan

**The write path, the validator, the preview and the record all exist; the page is the join.**
`PUT /api/config` already deep-merges a partial body, validates it with the very function the
ticket names, refuses a stale revision and hot-reloads. The preview already returns the fully
resolved policy, so the form has its initial values without a default of its own. The start
comment already carries every field the history needs. The one thing the tree does not have
is a usage history: the Limits page and the health refresh both read the account and keep
nothing, so the graph is the one part that adds persistence — a bounded advisory file, the
one new writer in this change, on the collector's live path. The per-Todo switch is the same
story in miniature: the rule and the route exist; the dashboard has never shown either.

### Numbers, with their source

`size-baseline.json:3` `"limit": 300`; `pnpm ratchet --check` on `origin/main`:

| File | Lines | Budget | Note |
| --- | --- | --- | --- |
| `packages/jinn/src/gateway/api.ts` | 5126 | 5114 | already over (`node scripts/ratchet.mjs --check`: "grew past its baseline: 5114 → 5126 (+12)"); **this branch removes the preview block (−7) and adds one delegation line** — still red on the inherited violation, not on this branch's |
| `packages/web/src/lib/api.ts` | 1075 | 1075 | at budget; **not touched** — the page's client lives in `lib/api-idle-capacity.ts` |
| `packages/jinn/src/shared/engine-limits-claude.ts` | 263 | 300 | +2 (import, one call) |
| `packages/jinn/src/gateway/idle-capacity.ts` | 295 | 300 | −4 (the note's formatting moves out) |
| `packages/web/src/routes/settings/config-shape.ts` | 100 | 300 | +3 |
| `packages/web/src/routes/todos/task-page/task-page.tsx` | 584 | 586 | +0 — the switch is rendered from `props-rail.tsx` (244, no line budget) |
| `packages/web/src/routes/limits/use-engine-limits.ts` | 219 | 300 | shrinks: the polled-read policy moves out |
| every new file | ≤ 300 | 300 | the page is split by section: header/next-tick, policy form, history, graph |

## Summary

A new dashboard destination, **Auto-Dispatch**, with four sections: the next tick's reasoning
(the existing preview), the policy as a form that writes `gateway.idleCapacity` through
`PUT /api/config` with the config revision and shows the validator's refusal by field, the
starts the loop has made (parsed from the comments it already leaves, joined with each Todo's
title and status), and the Claude five-hour usage over the last twelve hours with the starts
and window resets marked and a projection of the current window to its reset against the
tier's ceiling, with a readout for the five-hour window and every weekly bucket of whether the allowance
runs out first — the weekly verdict leading the card, since that is what the operator asked
to see at a glance (operator clarification 2026-09-21: history and forecast are both wanted). Three read-only routes in one new domain module; one sampling hook
in the Claude collector; no new writer, no new table, no new validator.

**Constraints**: 300-line file limit with a shrink-only ratchet; four CI gates
(`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`); `api.ts` and `web/lib/api.ts` must
not grow; no chart library; phone width.

**Scale/Scope**: gateway — 3 new modules (record, history query, usage history), 1 domain
route module (preview moved; policy, history, usage added), 1 refactor, 1 hook; web — 1 route
with ~8 files, 2 leaf API clients, 1 extracted hook, 1 Todo-page switch, 6 one-line
registrations; ~9 test files.

## Technical Context

**Language/Version**: TypeScript on Node 24, ESM; React 19 + react-router in `packages/web`
**Primary Dependencies**: none added
**Storage**: `tmp/engine-limits/claude-usage-history.json` — advisory, written whole under a
per-process temporary name and renamed, bounded to 7 days (2 016 samples at the cadence;
2 500 as a safety cap the collapse never reaches; ~350 KB rewritten at most every 5 min),
readings within 5 min of the last collapsed; the history list reads the comments table
**Testing**: Vitest — gateway modules against a real SQLite store in a throwaway `JINN_HOME`;
web pure models as unit tests, the page with a mocked hook as the Limits page does
**Target Platform**: gateway process + dashboard bundle
**Performance Goals**: one comments-table scan per history read (bounded `LIMIT`); one file
read per usage read; no per-keystroke PUT (600 ms debounce)
**Constraints**: read-only routes; operator-only write through the existing gate

## Constitution Check

| Principle | Verdict | Evidence |
| --- | --- | --- |
| **I — never upstream** | PASS | Fork-local. |
| **II — direction, with rung stated** | PASS, **rung 4** | Stops at 4 on purpose: the decision moved to the system with the auto-start feature; this is the ceiling-and-stop switch and the audit that Principle II says an autonomous decision must have. No further decision exists here to move. |
| **III — verify the premise** | PASS | The ticket's premise ("config-file-only, no UI") verified: no route, page or nav entry references the feature beyond the preview. Its suggestion that the comment trail may suffice was checked field by field against `recordStart` and holds. Its question whether usage history already exists was checked: it does not. |
| **IV — Footprint Ladder** | PASS, **rung 1** | Extends config-reading UI, adds read-only GET routes. No MCP tool. |
| **V — no speculative infrastructure** | PASS | The usage sampler has one consumer, the graph, built in this change. The polled-read hook is extracted on its second caller, which is the rule's own trigger. The projection lives in the page because the page is its only consumer; a gateway module for it would be one-caller infrastructure, and a projection on the wire beside real samples would sooner or later be read as a reading (FR-001). No chart abstraction. |
| **VI — tests that can fail for a reason** | PASS | Parser round-trip and malformed-comment recovery; history query filters (author, kind, tombstone); sampler bounds and dedupe; validator-message-to-field mapping; form → PUT body; chart model (reset boundaries, empty states); projection — pure, `now` injected — (rate from a known series; gate before reset; exhaustion before gate; two samples → none; integer-quantised series over a short span → none; bursty flat-rise-flat series → slope from the fit, line anchored at the last reading; non-positive slope over a long span → flat; a scoped weekly bucket exhausting before `7d` → headline names it); the switch's PUT body; the extracted hook keeps `use-engine-limits.test.tsx` green; nav/route registration tests already in the tree. No snapshot tests. |
| **VII — plan opens with a `file:line` table** | PASS | Above, with rejections and sourced numbers. |
| **VIII — comments explain why and stay true** | PASS (obligation) | `docs/idle-capacity.md` "Configuration" and "Observing it" sections gain the dashboard; `tasks.md` of the auto-start spec's deferred "Dashboard editing of the tiers" is now done and is left as history, not edited. |
| **Hard constraint — public repo** | PASS | No names, keys or home paths. |

**Complexity Tracking**: none.

## Project Structure

### Documentation (this feature)

```
specs/003-auto-dispatch-ui/
├── spec.md
├── plan.md
├── research.md
└── tasks.md
docs/idle-capacity.md          # gains the dashboard
docs/talk-control-coverage.md  # regenerated
```

### Source Code (repository root)

```
packages/jinn/src/
├── shared/
│   ├── idle-capacity-record.ts        # formatStartNote / parseStartNote — one grammar, both directions
│   ├── claude-usage-history.ts        # recordClaudeUsageSample / readClaudeUsageHistory (bounded file)
│   └── engine-limits-claude.ts        # +1 call on the live path
├── gateway/
│   ├── idle-capacity-api.ts           # GET /api/idle-capacity (moved), /policy, /history, /usage
│   ├── idle-capacity-history.ts       # comments by (system, idle-capacity) → StartRecord[] joined with Todo
│   ├── idle-capacity.ts               # recordStart formats through the record module
│   └── api.ts                         # preview block → one delegation line
└── __tests__
    ├── shared/__tests__/idle-capacity-record.test.ts
    ├── shared/__tests__/claude-usage-history.test.ts
    └── gateway/__tests__/idle-capacity-api.test.ts   # history + usage routes against the real store

packages/web/src/
├── hooks/use-polled-read.ts           # extracted from use-engine-limits: guard, timeout, visibility, reconnect, clock
├── lib/api-idle-capacity.ts           # types + four GETs (leaf: authFetch only)
├── lib/api-dispatch-config.ts         # PUT dispatch-config { autoStart } (leaf; lib/api.ts is at budget)
├── routes/limits/use-engine-limits.ts # consumes use-polled-read; keeps mergeAuthoritative and its exports
├── routes/todos/task-page/auto-start-row.tsx   # the switch, rendered from props-rail
├── routes/auto-dispatch/
│   ├── page.tsx                       # layout, header, refresh, save status
│   ├── use-auto-dispatch.ts           # preview/history/usage via use-polled-read; policy read once + after save
│   ├── next-tick-card.tsx             # tier, evidence, verdict, windows, window count
│   ├── policy-form.tsx                # the block as controls; writes via useConfigCommit
│   ├── policy-model.ts                # block ↔ form fields; problem message → field path
│   ├── history-list.tsx               # StartRecord rows
│   ├── usage-chart.tsx                # inline SVG
│   ├── usage-chart-model.ts           # samples + starts → points, resets, ticks
│   ├── usage-projection.ts            # pure: samples sharing a reset + ceiling + now → slope, at-reset %, gate/exhaustion instants, readout
│   └── __tests__/ (policy-model, usage-chart-model, page)
├── routes/settings/config-shape.ts    # gateway.idleCapacity typed
├── lib/app-routes.ts, lib/nav.ts, main.tsx, components/talk/context/coverage.ts,
│   components/global-search/static-pages.tsx, routes/more/page.tsx   # registrations
```

## Execution Order

1. Record module + refactor of `recordStart` — round-trip test proves the wording is
   unchanged before anything reads it.
2. History query + domain route module (preview moved, history added) with a store-backed
   route test; `api.ts` delegation.
3. Web: extract `usePolledRead` (Limits suite green), registrations, API clients, hook,
   page shell with next-tick card and history list.
4. Policy route; policy form: model + form + write through `useConfigCommit` gated on the
   revision; refusal-to-field mapping.
5. Todo-page auto-start switch.
6. Usage sampler + `/usage` route + chart model + projection + chart.
7. Docs, spec artefacts, gates, ratchet.

## Post-Design Constitution Re-check

Re-run after design review round 0 (senior-developer-qa): the addendum's per-Todo switch was
missing and is now User Story 5 with the existing rule and route cited; the form's seed moved
from the preview to a policy route that carries the revision, closing a write-without-revision
gap; the commit model moved from debounce to blur/Enter for fields, with the field-by-field
argument recorded; the refresh policy is extracted rather than copied (Principle V); the
sampler gained an atomic per-process write, a 5-minute collapse, the no-reset rule and a
minimum span for projections; the "no new writer" claim was corrected. The table above was
re-verified afterwards.
