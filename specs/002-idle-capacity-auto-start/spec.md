# Feature Specification: Idle-Capacity Auto-Start

> **Superseded.** The numeric idle-capacity loop and its policy form were replaced by the board walk (`board-walk.md`); see `docs/idle-capacity.md`. Kept as the record of what was built.

**Feature Branch**: `feat/idle-capacity-auto-start`

**Created**: 2026-09-20

**Status**: Implemented — awaiting review

**Input**: The originating Todo (body + operator comments): "Idle-capacity auto-start cron using
existing Claude usage-limits data" — check the account's real five-hour and weekly windows
before each reset and, when there is meaningful unused capacity, start eligible backlog Todos
to use it rather than let it lapse; three aggressiveness tiers (overnight / daytime / operator
live), configurable thresholds and time windows, reset timestamps surfaced, a precise "active
session" definition, and an OpenCode investigation.

## Why This Matters *(constitution Principle II)*

Rung **1** of Principle II's ranking: work starts without a human starting it, on spare
capacity. This is the specific waste the constitution names — *"a backlog of low-priority work
and hours of unspent quota, and does neither because nobody typed a command"* — closed for the
one engine whose quota Jinn can actually read.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The window is about to lapse with work waiting (Priority: P1)

The operator's Claude subscription is idle: nobody is using it, a five-hour window is an hour
from reset with most of it unused, and the board has backlog Todos. The system starts one, so
the allowance is spent on work rather than destroyed at reset.

**Why this priority**: it is the whole feature. Without it nothing else here has a purpose.

**Independent Test**: with the feature enabled and a reading of "5h 15% used, resets in 40
min; 7d 30%", one tick starts the highest-priority eligible backlog Todo through the built-in
Todo Dispatcher and leaves a system comment on it saying which reading it acted on.

**Acceptance Scenarios**:

1. **Given** a live reading with the five-hour window under the tier's ceiling and resetting
   within its lookahead, **When** a tick runs, **Then** exactly one eligible backlog Todo is
   dispatched, ordered highest priority then oldest, and a comment on it names the tier, the
   reading, the Dispatcher session and the count against the window cap.
2. **Given** the same reading but the window's reset beyond the lookahead, **When** a tick
   runs, **Then** nothing starts and the reason says which lookahead was not met.
3. **Given** any window above its ceiling, **When** a tick runs, **Then** nothing starts and
   the reason names the window and the ceiling.
4. **Given** the tier's `maxDispatchesPerWindow` starts already charged to this window's reset
   time, **When** a tick runs, **Then** nothing starts until the reading names a new reset.

---

### User Story 2 - Aggressiveness follows who is around (Priority: P1)

The operator set out three situations. Overnight with nobody around, the system should spend
deep into the window, keeping only a hard floor. In the daytime with no interactive session it
should start some work but leave real headroom. When the operator is live it should back off
almost entirely, whatever the hour.

**Why this priority**: the operator called the overnight floor non-negotiable and the
interactive back-off the point of the tiers; a flat policy is either too timid overnight or too
greedy while they work.

**Independent Test**: the same reading ("5h 60% used, resets in 4 h") starts a Todo at 03:00
local with nobody live, holds at 11:00, and holds at any hour while the operator is live.

**Acceptance Scenarios**:

1. **Given** the clock is inside the configured quiet hours and the operator is not live,
   **When** a tick runs, **Then** the overnight tier's ceilings, lookahead and cap apply.
2. **Given** the clock is outside the quiet hours and the operator is not live, **When** a tick
   runs, **Then** the daytime tier applies.
3. **Given** the operator is live, **When** a tick runs at any hour, **Then** the interactive
   tier applies — and it can be switched off outright in config.
4. **Given** the overnight tier, **When** the five-hour window is above the overnight ceiling
   (the hard floor), **Then** nothing starts.

---

### User Story 3 - The operator can see what it will do and why (Priority: P2)

Before enabling it, and whenever it surprises them, the operator asks the gateway what the next
tick would do: which tier, why (live or not, from which signal; quiet hours or not), the live
windows with their reset times, the backlog in the order it would try, what it skipped and why,
and how many starts are already charged to the window. Nothing starts from asking.

**Why this priority**: an automation that spends money and cannot explain itself will be
switched off. Rung 4 of Principle II is the floor under rung 1.

**Independent Test**: `GET /api/idle-capacity` returns the preview; the session count is
unchanged by the call.

**Acceptance Scenarios**:

1. **Given** the loop is running, **When** the preview is requested, **Then** it reports tier,
   operator evidence, quiet-hours flag, the verdict with each window's reset time and minutes
   to go, the eligible list in order, the skipped list with reasons, and the window's count.
2. **Given** a start happened this window and the loop now holds (a session is busy), **When**
   the preview is requested, **Then** the window's count still says 1.

---

### User Story 4 - Configurable without a redeploy (Priority: P2)

The operator adjusts the tiers' thresholds, the quiet hours and their zone, the cadence and
the operator-detection knobs in `config.yaml`, and the next tick uses them.

**Acceptance Scenarios**:

1. **Given** a well-formed `gateway.idleCapacity` block, **When** config reloads, **Then** the
   next tick runs under it without a gateway restart.
2. **Given** a malformed block, **When** config loads, **Then** it is refused with the exact
   key named, including a label the label normaliser would reject and a time zone the runtime
   does not know.

---

### Edge Cases

- A reading whose five-hour reset is in the past (the CLI statusline snapshot can name the
  previous window for up to 30 minutes after it rolled): **hold** — a window that no longer
  exists is not "0 minutes to go".
- A reading with no weekly window, or a window with no percentage or no reset: **hold**. A
  missing reading is a reason to hold, never to go.
- A stale, errored, static or unsupported reading: hold.
- Claude recorded as exhausted by the health store: hold before reading anything.
- A Todo whose next attempt is pinned to a non-Claude engine: skipped — the start exists to
  spend Claude allowance and would spend another provider's money instead.
- The Dispatcher already holds the Todo: not a second start; the next eligible Todo is tried.
- The loop's own started session moving the usage number between ticks must not read as the
  operator; usage rising while Jinn was quiet must.
- The operator watching `GET /api/idle-capacity` between two ticks must not shorten the
  interval the next tick's usage delta is measured over.
- The operator mid-conversation with the COO, turn finished, reading and typing: live.
- A five-hour usage number that drops (a new window) is never a delta.
- Two five-hour readings of the same window at different times keep the same window identity
  (its reset), so the per-window cap does not reset mid-window.
- A gateway restart forgets the per-window count; the live ceiling check on the next tick is
  the guard that remains.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST read the account's real Claude five-hour and weekly windows —
  used percentage **and reset time** — from the existing collector, and MUST NOT estimate
  either.
- **FR-002**: The system MUST decide without an LLM turn: the check is numeric and runs in the
  gateway on a timer. The Dispatcher's one turn is spent only after the decision to start.
- **FR-003**: The system MUST start a backlog Todo through the built-in Todo Dispatcher, the
  same spawn the board's dispatch button uses, and MUST tell the Dispatcher the start exists
  to use Claude allowance so it prefers a Claude-engine employee.
- **FR-004**: The system MUST apply one of three tiers per tick — overnight, daytime,
  interactive — each with its own five-hour and weekly ceilings, lookaheads, per-window start
  cap and busy-session limit, all configurable, each switchable off.
- **FR-005**: The tier MUST be chosen as: interactive if the operator is live; otherwise
  overnight inside the configured quiet hours (read in the configured IANA zone, wrapping
  midnight when asked); otherwise daytime.
- **FR-006**: "The operator is live" MUST mean: within `operatorActivity.idleMinutes` of the
  latest of (a) activity on an operator-driven session — top-level, not cron/Workflow-started,
  not a system employee's — (b) a Jinn interactive Claude session's statusline snapshot
  write, or (c) the five-hour used share rising by at least
  `operatorActivity.usageDeltaPercent` between two ticks' readings of the same window while
  no Jinn session was active in between. A preview MUST NOT advance signal (c)'s reference.
- **FR-007**: "A session holds engine capacity" MUST mean a Jinn session that is mid-turn or
  queued in transport, or parked on a gate (`waiting`), on any engine.
- **FR-008**: The system MUST hold when the reading is unusable: unsupported/static/error
  status, stale, missing the five-hour or weekly window, or naming a reset not still ahead.
- **FR-009**: The system MUST hold when any weekly bucket the account reports, per-model
  buckets included, is above the tier's weekly ceiling.
- **FR-010**: The system MUST start at most one Todo per tick and at most the tier's
  `maxDispatchesPerWindow` per five-hour window, the window identified by its reset time.
- **FR-011**: The system MUST skip backlog Todos that carry the `no-auto-start` label, have
  `autoStart: false`, have a dispatch override naming a non-Claude engine, or have an approval
  pending; and, when `requireLabel` is set, all that lack it. A parked Todo is `blocked`, not
  `backlog`, so it is never a candidate; it becomes one when its park runs out and the work-item
  reconciler re-queues it.
- **FR-012**: Every start MUST leave a system comment on the Todo naming the tier, the reading,
  the Dispatcher session and the count against the window cap, and one gateway log line.
- **FR-013**: The system MUST expose a read-only preview of the next tick (`GET
  /api/idle-capacity`) that starts nothing.
- **FR-014**: The feature MUST be off unless `gateway.idleCapacity.enabled` is true, and a
  malformed block MUST be refused at config load with the key named.
- **FR-015**: The Limits reading for OpenCode MUST state that no quota endpoint exists rather
  than "no collector is registered".

### Key Entities

- **Policy**: the resolved `gateway.idleCapacity` — cadence, zone, quiet hours, operator
  detection knobs, three tier policies, optional opt-in label.
- **Tier policy**: enabled flag, five-hour and weekly `{ maxUsedPercent, lookaheadMinutes }`,
  `maxDispatchesPerWindow`, `maxActiveSessions`.
- **Window reading**: name, used percentage, reset time (unix seconds), minutes to reset.
- **Verdict**: act or hold, the tier, the trigger (5h or 7d), the reason, the readings.
- **Window ledger**: starts charged to a five-hour window, keyed by its reset time (in-memory).
- **Operator sighting**: the latest sign of the operator and which signal produced it.

## Success Criteria *(mandatory)*

- **SC-001**: With the feature enabled and the account idle, a five-hour window that would have
  reset with more than the tier's headroom unused instead has at least one backlog Todo
  started against it before reset — observable as the system comment on the Todo.
- **SC-002**: No start ever happens above a tier ceiling, in a busy state, over the window cap,
  or from an unusable reading — each is a red test if removed.
- **SC-003**: The preview explains every hold with the same reason the tick would have used.
- **SC-004**: Changing a tier in `config.yaml` takes effect on the next tick with no restart.

## Open Decisions *(for the operator)*

1. **No stop-on-ceiling.** A ceiling gates *starting*; a started session runs to completion,
   so a start late in a window can carry the window past its ceiling and into the next one.
   The overnight floor is therefore a floor on starting, not a guarantee on consumption.
   Interrupting a running Todo session when a window crosses a line is a larger design
   (which session, what happens to its Todo, how it resumes) and is deliberately left out of
   this version. Accept, or open a follow-on.
2. **Downstream engine is not constrained.** The Dispatcher is told to prefer a Claude-engine
   employee and Todos pinned to another engine are skipped, but the Dispatcher's routing is
   its own; the default producer in this org (`junior-developer`) runs on OpenCode. Accept, or
   ask for a hard rule (Claude-engine assignee only) in a follow-on.
3. **An idle night may start nothing.** An account with no five-hour window open reports no
   reset for it; the loop holds until something opens a window, so a fully idle night is not
   "spent". Consistent with the feature's premise (no capacity is lapsing), but worth one
   preview watched through a first night.
4. **The five-hour cadence is never inferred.** The operator asked whether the account's
   five-hour-window pattern needs to be learned empirically. It does not: every reading
   carries the window's actual reset time, and the loop acts on that. No cadence assumption
   exists anywhere in the design.

## Assumptions

- The existing Claude collector's reading is authoritative for the account, including use from
  Claude Code sessions outside Jinn (it is the OAuth usage API the CLI's `/usage` uses).
- Date-gated Todos are parked: moved to `blocked` (no `blockKind`, or any kind but `dependency`)
  with `parkedUntil`. A bare `parkedUntil` on a `backlog` Todo, or on a `dependency` block, cannot
  hold a park — the write that makes either deletes it — and the gateway refuses both. A park
  returns the Todo to the queue by itself once `parkedUntil` passes. The loop cannot
  read a date out of a title, and does not read `dueAt`, which means a deadline elsewhere.
- The operator's quiet hours are roughly 01:00–06:00 Europe/London; both are config.
- OpenCode is out of scope after investigation: no windowed quota exists to read.
