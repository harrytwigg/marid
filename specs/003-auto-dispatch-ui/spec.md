# Feature Specification: Auto-Dispatch Dashboard

**Feature Branch**: `feat/gen-100-auto-dispatch-ui`

**Created**: 2026-09-21

**Status**: Designed — awaiting plan review

**Input**: Todo "Auto-dispatch UI: visual idle-capacity config + dispatch history +
usage graph". Follow-on to the idle-capacity auto-start work (PR #17), which shipped it as a
gateway loop configured only through `gateway.idleCapacity` in `config.yaml`, with no dashboard
surface — which is why the operator could not find it in Settings. Three parts: a visual
editor for every `gateway.idleCapacity` setting that takes effect the way a config edit does
today; a list of what the loop has actually started, with the reading it acted on; and a
usage-over-time graph with the starts marked on it. The ticket filed the graph as a stretch;
the operator's follow-up (2026-09-21) said the historical view is needed as well, so it is a
must-have here, ranked after the two lists it draws on. The same addendum asks for a per-Todo
"don't auto-start" control on the Todo detail view (User Story 5), distinct from the global
policy — the backend rule already exists; only the control is missing.

## Why This Matters *(constitution Principle II)*

Rung **4** of Principle II's ranking — *the operator gets a better view of a decision they
still have to make themselves* — and it stops there deliberately. The decision itself (rung 1)
already moved to the system with the auto-start feature. What Principle II demands of an autonomous decision is
the two things it withholds licence for: **a stated ceiling and a way for the operator to stop
it**, and **legibility** — *"what ran, what it cost, what it decided"*. Today both live in a
YAML block and a scattering of Todo comments. This feature is the ceiling-and-stop switch in
the operator's hand and the record of what was decided in one place; it moves no further
decision to the system because there is no further decision here to move.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The operator finds and tunes the policy from the dashboard (Priority: P1)

The operator opens a new **Auto-Dispatch** destination in the dashboard rail. It shows whether
the loop is on, and every setting that governs it — the enabled flag, the three tiers with
their ceilings, lookaheads, per-window start caps and busy-session limits, the quiet hours and
their zone, the cadence, the operator-detection knobs and the opt-in label — as form controls.
Changing one writes it to `config.yaml` through the same path the Settings page uses; the loop
reads the new value on its next tick, with no restart.

**Why this priority**: it is the reason the ticket exists. A policy the operator cannot see is
a policy they will not enable.

**Independent Test**: with the gateway running, set the daytime five-hour ceiling from 50 to
40 on the page; `config.yaml` carries `gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent: 40`
within a second, and `GET /api/idle-capacity` reports the resolved policy with that value.

**Acceptance Scenarios**:

1. **Given** the page is open, **When** it loads, **Then** every control shows the resolved
   value the loop is using right now — defaults included, not blanks for keys the file omits —
   and the form does not accept an edit until the config revision it will save against has
   arrived (values and revision come from one response, so there is no gap between them).
2. **Given** a valid edit, **When** it is committed (a toggle on click; a text or number
   field on blur or Enter), **Then** one PUT carries the `gateway.idleCapacity` block with the
   revision, the status pill says Saved, and the next tick uses it.
3. **Given** an edit the config validator refuses (a ceiling of 120, a quiet-hour of `25:00`, a
   zone the runtime does not know, a label with no letter or digit), **When** it is saved,
   **Then** the file is untouched, the refusal names the key, and the page shows that refusal
   against the field it names.
4. **Given** the file changed under the page (a hand edit in a terminal), **When** the page
   saves, **Then** the save is refused as a conflict, nothing is overwritten, and Reload
   re-reads the file and adopts its revision.
5. **Given** the loop is disabled, **When** the page loads, **Then** the form is still shown
   and editable, and the next-tick summary says the loop is off.
6. **Given** the operator is typing a number and pauses mid-value, **When** no blur or Enter
   has happened, **Then** nothing is written — the value on the wire is never a prefix of the
   one intended.

---

### User Story 2 - The operator can see what the loop actually did (Priority: P1)

Below the policy, a list of every Todo the loop has auto-started: when, which Todo (linked, with
its title and current status), under which tier and trigger, the reading it acted on (the
five-hour and weekly percentages and their minutes-to-reset at that moment), the Dispatcher
session, and the count against the window cap. Newest first.

**Why this priority**: the operator asked to *check its judgement rather than trust it blind*.
Without this the only record is a comment buried on each Todo.

**Independent Test**: after one start, the list shows one row whose fields equal the values in
the system comment on that Todo; a comment by any other author, or a tombstoned one, does not
appear.

**Acceptance Scenarios**:

1. **Given** the loop has started Todos, **When** the page loads, **Then** each start is one
   row carrying timestamp, Todo id + title + status, tier, trigger, five-hour and weekly
   readings, session id and `n of cap`.
2. **Given** no start has ever happened, **When** the page loads, **Then** the list says so
   rather than rendering nothing.
3. **Given** a start whose Todo has since been closed or archived, **When** the page loads,
   **Then** the row is still listed with the Todo's current status.

---

### User Story 3 - The operator can see the next tick's reasoning (Priority: P3)

At the top of the page: what the next tick would do and why — the tier and its evidence
(operator live or not, from which signal; quiet hours or not), the verdict against the live
windows with each reset, how many starts are charged to the current window, and how many
backlog Todos are eligible. Nothing starts from looking.

**Why this priority**: the read-only preview already exists (`GET /api/idle-capacity`); the
dashboard is where the operator will look for it, and the history list is only half the
picture without the *why* of the next start.

**Acceptance Scenarios**:

1. **Given** the loop is running, **When** the page loads, **Then** the summary shows the
   preview's tier, reason, operator evidence, quiet-hours flag, window readings and window
   count, and refreshes on the same cadence as the Limits page while the tab is visible.
2. **Given** the gateway reports no loop (503 from the preview — a test-only state, since
   `server.ts` always starts it), **When** the page loads, **Then** the summary says so and
   the policy form (seeded from the policy route, which needs no loop) and the history are
   still shown.

---

### User Story 4 - Usage over time, with the starts on it, and where it is heading (Priority: P2)

A graph of the Claude five-hour window's used share over the last twelve hours, drawn from
readings the gateway has taken, with each auto-start marked at the moment it fired and each
window reset marked where the reading rolled to a new window — so the operator can see *usage
was climbing, the loop started something here, the window reset there*. On top of the
history, a **projection**: from the rate of the current window's readings, where the used
share will be at the window's reset — drawn as a dashed extension from the last reading to
the reset, against the active tier's ceiling — and, as a plain readout for both windows,
whether the allowance is on track to be exhausted (or the ceiling reached) before the reset,
and roughly when. (Operator clarification, 2026-09-21: both are wanted — the actual history
*and* the forward view; neither replaces the other.)

**Why this priority**: the operator needs the historical view, not only the list — a row per
start says *that* it fired; only the line says whether it fired at a sensible point in the
window. No usage history exists in the tree today (the Limits page keeps only its last-known
reading in memory), so this is the one part that needs new persistence; it ranks after
Stories 1–2 only because it draws its markers from Story 2.

**Acceptance Scenarios**:

0. **Given** the card, **When** it renders, **Then** its headline is the weekly verdict — the
   operator's stated purpose is "will the week's allowance run out before the weekly reset,
   at a glance" — over every weekly bucket the account reports (`7d` and each per-model
   `7d <model>`, which exhaust independently and which the loop already holds to the weekly
   ceiling), leading with whichever exhausts first; the five-hour projection and the graph
   are the supporting detail beneath it.
1. **Given** readings have been taken over the period, **When** the page loads, **Then** the
   graph shows them as a line, with the starts from User Story 2 marked on the same time axis.
2. **Given** the five-hour reset time changes between two consecutive readings OF THAT
   WINDOW — an untouched window right after a roll reports no reset and so has no five-hour
   entry in the samples between the roll and the first use, and the marker must still be
   found across that gap (A, absent × n, B) — **When** the graph is drawn, **Then** a reset
   marker is placed between them.
3. **Given** fewer than two readings exist, **When** the page loads, **Then** the graph area
   says it is waiting for readings rather than drawing an empty axis.
4. **Given** at least three readings of the current five-hour window spanning at least 30
   minutes, **When** the graph is drawn, **Then** a dashed projection runs from the LAST
   reading (the fit supplies only its slope, never its intercept — usage is bursty and a
   whole-window fit averages across idle gaps) to the window's reset, clamped at 100; the
   five-hour ceiling of the tier the preview currently reports is drawn as a line (it
   follows the preview, so it can switch while the operator watches — the label names the
   tier); and the readout says, whichever comes first: "linear, at the last <span> rate: N%
   by <reset>"; "the <tier> tier stops starting work at M% — at this rate, about <time>"
   (a start gate, not a problem); or "exhausts the allowance at about <time> — refused until
   the reset" (the real warning).
5. **Given** at least three readings of a weekly bucket spanning at least 30 minutes, **When**
   the page loads, **Then** the headline says where that bucket is heading by its reset at
   the rate of the retained readings, naming the basis in the sentence ("linear, at the last
   6 d 4 h rate: 91% by Tue 14:00", or "exhausts the allowance about Mon 09:00 — refused
   until the reset"). Readings are retained for the whole week, so the basis is the current
   week, not two days of it; the phrase "linear, at the last <span> rate" is the entire
   caveat — no band, nothing that implies a model.
6. **Given** fewer than three readings of a window, or readings spanning less than 30
   minutes (used share is reported as a whole number, so a short span gives a quantised
   rate), **When** the graph is drawn, **Then** no projection is drawn and the readout says
   the rate is not known yet. **Given** enough readings with a slope of zero or below,
   **Then** the readout says "flat at N%" — a drop within one reset instant cannot happen
   (a lower number is a new window, grouped by its own reset), so a non-positive fit is a
   quiet window, not an error.
7. **Given** a reading whose window carries no reset instant (an untouched window reports
   none), **When** samples are recorded and grouped, **Then** that window is left out of the
   sample, exactly as the loop's own reading rule leaves it out of the verdict; no reset
   marker is drawn between a reading with a reset and one without.

---

### User Story 5 - The operator keeps one Todo out of the loop's hands (Priority: P2)

On a Todo's detail page, a switch: **Auto-start** on or off. Off means the idle-capacity loop
never starts this Todo, however the global policy is set (the assignment auto-start Workflow
honours the same flag when its trigger sets the `autoStart: true` filter). The rule already exists in the gateway — the loop skips a
Todo whose dispatch config says `autoStart: false` — and the route to set it already exists;
what is missing is any way to set it from the dashboard.

**Why this priority**: the operator asked for it by name, and a global policy with no
per-item exception makes the operator label Todos by hand to protect them.

**Independent Test**: switch it off on a backlog Todo; `GET /api/idle-capacity` lists that
Todo under `skipped` with reason `autoStart is false`; switch it on and it is eligible again.

**Acceptance Scenarios**:

1. **Given** a Todo with no dispatch config, **When** its page loads, **Then** the switch
   shows on (the default the loop applies).
2. **Given** the operator turns it off, **When** the write completes, **Then** the body was
   `{ autoStart: false }` and nothing else, the Todo page reflects it after refetch, and the
   next preview skips the Todo with that reason.
3. **Given** the Todo also carries the `no-auto-start` label, **When** the switch is on,
   **Then** the loop still skips it (the label rule is independent); the row says so.

---

### Edge Cases

- A field cleared to blank mid-edit is not a value: nothing is written until the field parses,
  and the field is marked as needing one.
- Text and number fields commit on blur or Enter, never per keystroke. The argument that an
  intermediate value is at least as conservative as the final one holds only for the two
  ceilings, the two lookaheads, the two caps and `usageDeltaPercent`; it fails for
  `idleMinutes` (a prefix forgets the operator sooner), `intervalMinutes` (a prefix of `10`
  is a one-minute cadence), the quiet hours (an intermediate complete time can widen the
  overnight window), `timezone` (`EST`, `GB`, `Etc/GMT` are valid prefixes of other zones)
  and `requireLabel` (a prefix can be another label). One commit rule for every field is
  simpler than two, and toggles are one click anyway.
- `requireLabel` left empty means *no opt-in label* — sent as `null`, which the merge treats as
  "remove the key", and the policy resolves to its default `null`.
- A start whose comment failed to write (the loop logs the failure and carries on) is absent
  from the history: the comment trail is the record, and the gateway log is the fallback.
- A comment the operator edited by hand may no longer parse; it is listed with the fields the
  parser could recover and the rest blank, never dropped.
- The resolved policy and the config revision arrive in ONE response
  (`GET /api/idle-capacity/policy`, which carries `X-Jinn-Config-Revision`), so the form
  cannot be edited against values from one file state and a revision from another; the
  write hook refuses to send until that revision is held, because a PUT with no revision
  bypasses the staleness check by design. A save adopts the revision the PUT returns — and
  nothing else re-reads the policy after a save: the hook drops any queued edit when a
  revision is adopted, so a post-save re-seed would silently discard the field the operator
  had just moved on to. After a save only the preview is re-fetched.
- Inherited from the Settings page, not fixed here: the revision is the file's and the
  values are the gateway's in-memory config; a hand edit is reloaded by the watcher a moment
  later, so a page that loads inside that moment holds a fresh revision over stale values.
- A deleted comment is tombstoned (body cleared), so a start whose comment the operator
  deleted is unrecoverable from the trail: the audit is operator-deletable, and the gateway
  log is the only other record.
- Usage readings are taken only from live OAuth readings; a stale statusline snapshot is not a
  point on the graph. Readings within five minutes of the last recorded one collapse to it
  (the page's own preview poll would otherwise record one a minute); the history is bounded
  to seven days (2 016 samples at that cadence) and, as a safety cap the collapse never
  reaches, 2 500 samples — about 350 KB rewritten at most once per five minutes. The page
  polls usage on that same five-minute cadence; nothing new can appear sooner.
  Two writers can race (the gateway and `jinn limits` on the same host, or two in-process
  readers): the file is written whole under a per-process temporary name and renamed, so a
  race loses one sample, never the file.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard MUST have an `Auto-Dispatch` destination in the rail (and the
  mobile More screen, the command palette's static pages and Talk coverage, as every
  destination has).
- **FR-002**: The page MUST render every key of `gateway.idleCapacity` — `enabled`,
  `intervalMinutes`, `timezone`, `quietHours.start/end`, `operatorActivity.idleMinutes`,
  `operatorActivity.usageDeltaPercent`, `requireLabel`, and for each of the three tiers
  `enabled`, `fiveHour.maxUsedPercent`, `fiveHour.lookaheadMinutes`, `sevenDay.maxUsedPercent`,
  `sevenDay.lookaheadMinutes`, `maxDispatchesPerWindow`, `maxActiveSessions` — pre-filled with
  the resolved policy the loop is using.
- **FR-003**: Edits MUST be written through `PUT /api/config` carrying the config revision, as
  a partial body holding the full `gateway.idleCapacity` block, and MUST NOT introduce a second
  config-mutation route or a second copy of the validator. Validation is the gateway's
  `idleCapacityProblems`; the page surfaces its refusal by key. The page MUST NOT send a
  write without the revision, and MUST read values and revision from one response.
- **FR-003a**: Toggles commit on click; text and number fields commit on blur or Enter; a
  field that does not parse commits nothing.
- **FR-004**: A save refused as a config conflict MUST leave the file untouched and offer a
  reload, exactly as the Settings page does.
- **FR-005**: The page MUST list the loop's starts from the system comments it already leaves
  (author `idle-capacity`, kind `system`), newest first, each with timestamp, Todo id, title,
  current status, tier, trigger, five-hour and weekly readings, Dispatcher session and window
  count. No new table or log is introduced for this.
- **FR-006**: The comment the loop writes and the parser the history reads MUST be the same
  module, formatting from the structured verdict the loop already holds, with a round-trip
  test whose input is a real `evaluateIdleCapacity` verdict (the window grammar lives in
  `shared/idle-capacity.ts`, and a reword there is what the test must catch). The grammar
  MUST accept window names with spaces and parentheses and a negative minutes-to-reset. The
  readings in a history row are the comment's as printed (`formatMinutes` drops minutes at
  a day or more), which is exact for the five-hour window and to the hour for the weekly.
- **FR-007**: The page MUST show the next tick's preview (tier, evidence, reason, windows,
  window count, eligible count) and refresh it while visible; it MUST NOT call anything that
  starts a Todo.
- **FR-008**: The new routes (`/api/idle-capacity/history` and `/api/idle-capacity/usage`) MUST be read-only and live in their own domain module beside the
  existing preview route; `gateway/api.ts` MUST NOT grow.
- **FR-009**: The gateway MUST keep a bounded history of live Claude five-hour and
  weekly readings — seven days, so a weekly projection reads the current week — written on
  the Claude collector's live path (the one place every reading passes through, including
  the loop's direct call), atomically under a per-process temporary name, and serve the last
  N hours of it (N ≤ 168). Windows without a reset instant are
  left out of a sample. The graph MUST mark the starts from FR-005 and the window resets on
  the same axis. While the loop is disabled the fifteen-minute engine-health refresh is what
  feeds the history, which is enough for a twelve-hour view and a weekly indication.
- **FR-010**: Everything the page shows MUST work at phone width without horizontal scroll.
- **FR-011**: The page MUST project each window's used share to its reset from the rate
  observed across that window's readings: a least-squares slope over the samples sharing the
  window's reset instant (≥ 3 samples spanning the window's minimum — 30 min for the
  five-hour window, 6 h for a weekly bucket), anchored at the last reading,
  clamped at 100. It MUST draw the five-hour projection as a dashed extension against the
  five-hour ceiling of the tier the preview reports, and state for the five-hour window and
  for every weekly bucket whether and roughly when the allowance is exhausted or the tier's
  start gate reached before the reset, naming the basis ("linear, at the last <span> rate")
  in the sentence. The weekly verdict leads the card, worst bucket first. The projection is
  a pure function `(samples, window, ceiling, now) → projection | none` in the page, with
  `now` injected; the gateway computes, persists and logs no projection, and the loop's
  decision never reads one (FR-001 still holds: readings are read, never
  estimated; the loop reads live windows only).
- **FR-012**: The Todo detail page MUST show the Todo's auto-start flag (on unless its
  dispatch config says otherwise) as a switch that writes `{ autoStart }` — and nothing else —
  to `PUT /api/work-items/:id/dispatch-config`, through a leaf client module, and refetches
  the Todo afterwards.
- **FR-013**: The Limits page's refresh policy (in-flight guard, request timeout, refresh
  while visible, refresh on visibility return and on reconnect, display clock) MUST be
  extracted into one hook that both Limits and this page consume; Limits keeps its own merge
  rule.

### Key Entities

- **Policy block**: the `gateway.idleCapacity` mapping as the page writes it — every key
  explicit, seeded from the policy route's `policy`, read on load and on Reload only.
- **Start record**: one auto-start as the loop holds it when it comments — `tier`,
  `trigger`, `fiveHour {name, usedPercent, minutesToReset}`, `weekly[]` of the same,
  `sessionId`, `charged`, `cap` — formatted into the comment and parsed back from it; a
  history row is that plus the comment's `workItemId`, `startedAt` (the comment's
  `createdAt`) and `commentId`, joined at read time with the Todo's `title` and `status`.
  A row from a comment that no longer fully parses carries the fields recovered and is
  flagged `partial`.
- **Usage sample**: `{ at, windows: [{ name, usedPercent, resetsAt }] }` from one
  live reading.
- **Projection**: for one window — `ratePerHour` (the fit's slope; the line is anchored at
  the last reading), `basis` (the span the rate was fitted over, named in the readout),
  `atReset` (used % expected at the reset, clamped at 100), `gateAt` (when the tier's start
  gate is reached, or none), `exhaustsAt` (when 100 is reached, or none), or `none` with a
  reason (`too-few`, `too-short`) — a pure function of the samples sharing the window's
  `resetsAt`, a ceiling and an injected `now`. Never persisted, never logged, never read by
  the loop.
- **Dispatch config**: the Todo's `{ autoStart, engine, model, skills }` as the detail payload
  already carries it; the switch reads `autoStart` and writes only `autoStart`.

## Success Criteria *(mandatory)*

- **SC-001**: The operator can enable the loop, set every tier, and see the change reflected
  in `GET /api/idle-capacity` without touching `config.yaml` or restarting.
- **SC-002**: A malformed value never reaches the file — each of the validator's refusals is
  shown against its field, and the file's revision is unchanged afterwards.
- **SC-003**: Every start the loop has commented on appears in the history with the values of
  that comment; nothing else does.
- **SC-004**: `gateway/api.ts` and `web/src/lib/api.ts` are no larger than on `origin/main`;
  every new file is under the 300-line limit.
- **SC-005**: A Todo switched off on its page is skipped by the next preview with the
  reason `autoStart is false`, and nothing else about its dispatch config changed.

## Open Decisions *(for the operator)*

1. **The page writes the whole block.** A save materialises every `gateway.idleCapacity` key
   into `config.yaml`, defaults included. This is a choice, not a constraint: the policy
   route can return the file's raw block beside the resolved policy, so the page *could*
   write a key only when the file already set it or the operator changed it, and send
   `null` for the rest. The trade-off is real: a complete block reads as self-describing
   (the shape `docs/idle-capacity.md` shows) and a hand edit sees every knob; a minimal
   block keeps this instance on the shipped defaults, so a future release that changes one
   changes it here too. The whole block is chosen for legibility. Accept, or ask for the
   minimal form. (On a fresh instance with no block on disk, `requireLabel: null` lands in the
   file as an explicit null, which the validator accepts and the resolver keeps; once a
   block exists, the merge deletes the key instead. Both resolve to "no label".)
2. **No Save button; toggles apply on click, fields on blur or Enter.** The Settings page
   applies every field on a debounce; this page does not, for the reasons in Edge Cases —
   five of its eleven fields are not safe at an intermediate value. The write path and the
   status pill are the Settings page's. Accept, or ask for an explicit Save on this page.
3. **The comment trail is the history.** It carries everything the ticket asks for, so no
   table is added; the costs are that a start whose comment failed to write is only in the
   log, and that the trail is operator-deletable (a tombstone has no body to parse).

## Assumptions

- The operator's dashboard session is the authenticated operator surface, which is what
  `PUT /api/config` requires.
- The idle-capacity loop is running in the gateway the dashboard talks to (the preview is
  503 otherwise, and the page says so).
- Twelve hours is the right default period for the graph; it is a query parameter.
