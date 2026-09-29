# Research: Auto-Dispatch Dashboard

Each entry: the question, what was found (with where), and the decision it led to.

## R1. Is there a config-mutation path the page can reuse, or does it need its own?

**Found**: `PUT /api/config` (`packages/jinn/src/gateway/api.ts:4530`) accepts a **partial**
body — "a PUT body is partial" is stated at the merge — deep-merges it into `config.yaml`
(`config-payload.ts:98`), runs `validateConfigShape` on the merged result (`api.ts:4579`),
which already includes `idleCapacityProblems` (`shared/config.ts:71`), writes atomically and
calls `reloadConfig` (`api.ts:4582`). It refuses a stale `X-Jinn-Config-Revision`
(`api.ts:4546`) so a hand edit under an open page is never overwritten. It is operator-only
(`api.ts:910`). The web side already has the hook that drives it — `useConfigCommit`
(`packages/web/src/routes/settings/use-config-commit.ts:96`) — with the debounce, the
conflict notice and revision adoption.

**Decision**: no new config writer. The page PUTs `{ gateway: { idleCapacity: <block> } }`
with the revision through `useConfigCommit`. The Settings-page `Config` type gains the block
so the hook takes it without a cast. Checked on review (round 0) and holding: the partial
body passes the top-level key check (`gateway` is in `CONFIG_TOP_LEVEL_KEYS`); the env
host/port refusal skips when `body.gateway.host/port` are undefined (`api.ts:4555`); every
key explicit ⇒ merge ≡ replace for the block; the operator-only gate is
`operatorOnlyControlPlaneRoute` (`api.ts:910`); `reloadConfig` is synchronous so the next
tick sees the write. One residual is inherited from Settings and not fixed here: the
revision is the file's while the values are the in-memory config's, and the watcher reloads
a hand edit asynchronously — a page loading inside that window holds a fresh revision over
stale values.

**Revision gate (round 0, blocking).** `useConfigCommit` sends no revision header while it
holds none (`use-config-commit.ts:70`, `api-config.ts:50`), and the route deliberately skips
the staleness check for such a caller (`config-revision.ts:45`). Settings is safe because it
renders no form until `GET /api/config` returns. This page therefore (a) seeds the form and
takes the revision from ONE response (R2), and (b) passes a `blocker` that refuses the write
until `adoptRevision` has run.

## R2. Where do the form's initial values come from without a web copy of the defaults?

**Found**: `GET /api/idle-capacity` returns `policy` — `resolveIdleCapacityPolicy` applied to
the file block (`gateway/idle-capacity.ts:220`, `shared/idle-capacity-config.ts:134`) — so
every key is explicit. But it needs the loop (503 otherwise), runs the collector on every
call (`idle-capacity.ts:154`: an OAuth round-trip before the form's first paint), and carries
no revision. `GET /api/config` returns only what the file holds (a block with most keys
missing on a fresh instance) and the revision.

**Decision** (revised on review): a fourth read-only route in the domain module,
`GET /api/idle-capacity/policy`, returns `{ policy, configured }` — the resolved policy and
the raw file block — with the `X-Jinn-Config-Revision` header, exactly as `GET /api/config`
sets it. No collector, no loop. The form is seeded from `policy` and the revision adopted from
the same response. `configured` is what makes the minimal-write alternative in Open Decision
1 possible; the whole block is written regardless, for legibility.

## R3. Can the page validate before the wire without a second validator?

**Found**: every message from `idleCapacityProblems` starts with the offending key's path
(`gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent must be a number between 0 and
100 (got 120)`), and the route joins them as `Invalid config: a; b`. The path grammar is
stable: it is what the operator reads in the gateway log when the file is bad.

**Decision**: the page splits the refusal on `; `, takes each message's leading path, and
shows the message under that field. HTML `min`/`max`/`step` and `type="time"` give instant
feedback for the common slips; the validator stays the single truth.

## R4. Is the comment trail enough for the history, or is a table warranted?

**Found**: `recordStart` (`gateway/idle-capacity.ts:175`) writes one system comment per start,
author `idle-capacity`, kind `system`:

> Idle-capacity auto-start: `<tier>` tier, `<five-hour|weekly>` window about to lapse:
> `5h 13% used, resets in 40 min; 7d 68% used, resets in 2 d 3 h; 7d Fable 0% used, resets
> in 2 d 3 h`. Started the Todo Dispatcher (session `<id>`) to use capacity that would
> otherwise lapse; `<n>` of `<cap>` for this five-hour window.

That carries the tier, the trigger, every window's used share and minutes-to-reset (via
`formatMinutes`, `shared/idle-capacity.ts:116`), the session and the count — every field the
ticket lists — plus `created_at` and `work_item_id` on the row. `work_item_events` records a
`comment_added` with only the comment id. No other record of a start exists.

**Decision**: the comment trail is the source of truth. `recordStart` already holds the
structured verdict (`fiveHour`, `weekly[]`, `trigger`, `tier`) plus the session, count and
cap, so `formatStartNote(record)` takes that record and `parseStartNote(body)` inverts one
grammar, both in `shared/idle-capacity-record.ts`. The round-trip test builds its input from a
real `evaluateIdleCapacity` verdict — the window grammar (`describe`, `formatMinutes`) lives
in `shared/idle-capacity.ts`, and a reword *there* is what FR-006 must catch. The grammar
covers window names with spaces and parentheses (`7d Fable`) and a negative
minutes-to-reset (`reading()` rounds a past reset negative). A partially parseable comment
(hand-edited) yields the recovered fields flagged `partial`. A tombstoned comment has no body
(`comments.ts:211`) — that exclusion is forced. The query is by `(author_kind, author)` on
`work_item_comments` with a `LIMIT`; no index is added at this table's size (the existing index
is per Todo). `formatMinutes` is inverted for the reading's minutes (`N min`, `H h M min`,
`D d H h`); the parser tolerates a comment it cannot fully read by returning the fields it
could.

## R5. Does any usage-over-time data already exist?

**Found**: none. `useEngineLimits` keeps the last-known response in React state and merges a
degraded refresh over it (`routes/limits/use-engine-limits.ts:135`); `background-refresh.ts`
reads every 15 min and keeps nothing but exhaustion (`engine-health.ts:179`); the CLI
statusline recorder writes one file per session that the collector reads as a fallback
(`engine-limits-claude.ts:244`) — the latest snapshot, not a series. The loop itself keeps only
the last five-hour reading for the operator-delta signal, in memory.

**Decision**: a bounded advisory file, `tmp/engine-limits/claude-usage-history.json`, written
on the collector's live path (`engine-limits-claude.ts:251`) — the one place every reading
passes through, including the loop's direct call (`idle-capacity.ts:154`; the
`collectEngineLimits` side-effect site at `engine-limits.ts:363` would miss it) — following
the engine-health store's swallow-own-errors pattern. Conditions from review round 0:

- **Atomic under concurrency.** `engine-health-store.ts:70` renames from a fixed `.tmp`
  name; the gateway, `jinn limits` on the same host, and the preview/Limits/loop readers
  in-process can overlap. The history writes whole under a per-process temporary name and
  renames (`saveConfigAtomic`, `config.ts:286`). A lost sample under a race is accepted.
- **Collapse window above the poll period.** The page polls the preview every 60 s and each
  preview collects, so a 60 s collapse would record a sample a minute and the count cap
  would become the real bound. Readings within 5 min of the last recorded sample collapse
  to it: 144 points per 12 h.
- **Retain the week, not two days.** A weekly projection over 48 h of evidence extrapolated
  across five days answers differently depending on whether the basis spanned a weekend;
  at the 5-minute cadence a full week is 2 016 samples (~350 KB, rewritten at most every
  five minutes), so retention is 7 days with a 2 500-sample safety cap, the graph reads the
  12 h tail, and the page polls usage every 5 minutes — nothing new can appear sooner.
- **No reset, no sample.** `resetsAt` is undefined when the API reports none
  (`engine-limits-claude-usage.ts:6`); such windows are left out, mirroring
  `reading()` (`shared/idle-capacity.ts:102`), so grouping by `resetsAt` and reset markers
  never meet an undefined.
- **A disabled loop never collects** (`idle-capacity.ts:146` returns before `:154`), so the
  15-minute engine-health refresh feeds the graph then — four points an hour is enough.

Served by `GET /api/idle-capacity/usage?hours=` (clamped 1–168, default 168).

## R11. Where does the projection live, and how honest can a straight line be? (review round 0)

**Found**: the operator asked for a simple rate-based projection rather than a real
forecasting model. FR-001 makes "readings are read, never
estimated" a gateway invariant, and the loop's guard reads live windows only
(`gateway/idle-capacity.ts:154`). `usedPercent` is integer-rounded
(`engine-limits-claude-usage.ts:9`), so two readings a minute apart at 12% and 13% would fit
a slope of 60%/h. Five-hour usage is bursty (sessions start and stop), so a whole-window fit
averages across idle gaps. Per-model weekly buckets exhaust independently of `7d`, and the
loop already holds every `7d*` bucket to the weekly ceiling (`shared/idle-capacity.ts`,
`allModels` vs `weekly`).

**Decision**: the projection is a pure function in the page — `(samples sharing a reset,
ceiling, now) → projection | none` — with `now` injected; the gateway never computes,
persists or logs one, and nothing on the wire could be mistaken for a reading. Linear
least-squares is the honest answer to the ask, bounded four ways: the fit supplies the slope
only and the line is anchored at the last reading; a projection needs at least three samples
spanning at least 30 minutes, else "rate not known yet"; the projected value is clamped at
100; a non-positive slope over enough span reads "flat at N%" (a drop means a new window, so
it is grouped away by its reset). The wording says what a line crossing means: the tier's
ceiling is a start gate ("the <tier> tier stops starting work at M% — at this rate, about
<time>"), 100% is the real warning ("exhausts the allowance at about <time> — refused until
the reset"), and the only caveat is the phrase "linear, at the last <span> rate". The weekly
verdict over every `7d*` bucket, worst first, is the card's headline; the five-hour
projection and the graph are the detail under it.

## R6. Where do the routes go when `api.ts` is over budget?

**Found**: `api.ts` is 5126 lines against a budget of 5114 (`size-baseline.json`); the ratchet
fails on growth. The tree's answer is the domain-module contract in `route-helpers.ts:1`
(`handle<Domain>Api` returning a boolean, dispatched from the spot the block used to occupy);
`work-item-kept-api.ts` is the smallest example. `web/src/lib/api.ts` is exactly at its
budget of 1075; `lib/api-config.ts` shows the leaf-module pattern (`authFetch` only).

**Decision**: `gateway/idle-capacity-api.ts` takes the preview route with it (the preview block
is replaced by one delegation line, a net shrink) and adds `/policy`, `/history` and `/usage`;
`web/src/lib/api-idle-capacity.ts` holds the client and types and is imported by the page's
hook directly, so `lib/api.ts` is untouched.

## R7. What does adding a dashboard destination touch?

**Found**: `APP_ROUTES` (`lib/app-routes.ts:18`), `BASE_NAV_ITEMS` (`lib/nav.ts:52`),
`routeElements` (`main.tsx:100`), `TALK_SURFACE_COVERAGE` (`components/talk/context/coverage.ts:31`,
whose test refuses a route without an entry and checks `docs/talk-control-coverage.md` starts
with the rendered table), `BASE_STATIC_PAGES` (`global-search/static-pages.tsx:10`), the More
screen tint (`routes/more/page.tsx:22`), and `lib/__tests__/nav.test.ts:39`'s overflow order.

**Decision**: one entry each; the label is `Auto-Dispatch`, the path `/auto-dispatch`, placed
after Limits in the rail. The doc is regenerated from the renderer, not hand-edited.

## R8. Instant apply or a Save button?

**Found**: the Settings page removed its Save button deliberately — `use-config-commit.ts`
says so twice (`:8`, `:133`) and `__tests__/instant-apply.test.tsx` locks it. Its number
fields (port, `tokenThreshold`) commit on change with the 600 ms debounce. The first draft
claimed the intermediate values of every field here are safe. Review round 0 checked the
claim field by field: it holds for the two ceilings, the two lookaheads, the two caps and
`usageDeltaPercent` (a prefix is at or below the final value, and smaller is safer or is
refused); it fails for `idleMinutes` (a prefix forgets the operator sooner), `intervalMinutes`
(`1` of `10` is a one-minute cadence, re-read at each fire — `idle-capacity.ts:284`), the
quiet hours (`type=time` emits complete intermediate values: 06:00→05:30 passes 05:00,
01:00→23:30 passes 23:00, widening the overnight window), `timezone` (`EST`, `GB`, `Etc/GMT`
are valid prefixes of other zones; every other keystroke is a refused PUT) and `requireLabel`
(a prefix can be another label).

**Decision**: no Save button, but no per-keystroke writes either: toggles commit on click;
every text and number field commits on blur or Enter. One rule for every field beats two,
and the hook is agnostic about when `commit` is called, so this is page-local and the
Settings precedent is untouched. Recorded as Open Decision 2.

## R9. Is the per-Todo "don't auto-start" rule wired? (addendum point 2)

**Found**: yes, both halves. `gateway/idle-capacity-backlog.ts:28` skips a Todo whose
dispatch config says `autoStart === false` (and `:21` one carrying the `no-auto-start`
label); `PUT /api/work-items/:id/dispatch-config` (`gateway/api.ts:3240`) accepts
`{ autoStart: boolean }` from the operator, the creator or the assignee and emits a
projection event; the detail payload carries `dispatchConfig` (`work-item-payload.ts:136`).
The dashboard has neither a client for the route nor a control: `grep dispatchConfig
packages/web/src` finds nothing, and the Todo page's rail (`props-rail.tsx:147`) offers a
Dispatch button only. The web wire type `WorkItemDetailWire` (`lib/api.ts:646`) does not name
the field, and that file is at its ratchet budget.

**Decision**: nothing to build in the gateway. A switch under the rail's Dispatch button,
in its own small component, reading `detail.dispatchConfig?.autoStart ?? true` and writing
`{ autoStart }` alone through a leaf client (`lib/api-dispatch-config.ts`), then refetching
the Todo. Off is shown with the reason the loop would give, and the row notes the
`no-auto-start` label when present since that rule is independent.

## R10. Does one more polled reader justify a shared hook? (review round 0)

**Found**: `useEngineLimits` (`routes/limits/use-engine-limits.ts:135`) is the only polled
reader with an in-flight guard, an abort timeout, a visibility pause, a reconnect refresh and
a display clock; `hooks/` has nothing equivalent. This page needs the same policy for three
reads. The first draft proposed a sibling copy and cited Principle V against generalising;
the principle says the opposite — extract on the second caller.

**Decision**: `hooks/use-polled-read.ts` takes a fetcher (with an abort signal), an optional
merge, and the four constants; `useEngineLimits` becomes a thin caller that passes
`mergeAuthoritative` and keeps its exports, and `use-engine-limits.test.tsx` is the proof the
extraction is faithful.
