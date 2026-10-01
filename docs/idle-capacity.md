# Idle-capacity auto-start

A Claude subscription meters two rolling windows — five hours and seven days.
Whatever is unused when a window resets is gone. The idle-capacity auto-start
watches the account's **real** windows (the same reading the Limits page and
`jinn limits` show), and when a window is about to reset with capacity to
spare, starts an eligible backlog Todo so the allowance is used rather than
lapsed. Spec: `specs/002-idle-capacity-auto-start/`.

It is a gateway loop, not a cron job. A cron job is a prompt run by an engine,
so it would spend Claude capacity — on the very window it is measuring — to
answer a question that is a handful of numeric comparisons. The loop decides in
code and starts the same built-in Todo Dispatcher the board's dispatch button
starts; that one Sonnet turn is where judgement is needed (which employee should own
the Todo).

## Three tiers

How aggressive the loop is depends on who is around:

| Tier | When | Default ceilings (5h / weekly) | Lookahead (5h) | Starts per 5h window |
|---|---|---|---|---|
| `overnight` | inside the quiet hours, operator not live | 85% / 85% | whole window (300 min) | 3 |
| `daytime` | outside the quiet hours, operator not live | 50% / 75% | 120 min | 2 |
| `interactive` | the operator is live, at any hour | 20% / 60% | 30 min | 1 |

Overnight spends deep because the window resets unused otherwise; the 15% it
leaves is the hard floor. Daytime leaves real headroom in case an interactive
session starts later. Interactive barely touches the window: one start, only
in the last half hour of a window that is almost untouched — and it can be
switched off outright (`tiers.interactive.enabled: false`).

**The operator is live** when any of three signals has fired within
`operatorActivity.idleMinutes` (default 30):

1. An **operator-driven session** had activity. That is a session whose turns
   the operator initiates: top-level (no parent session — a delegated or
   spawned child has one), not started by cron, and not a system
   employee's (the Todo Dispatcher and Shaper are started by the gateway on the
   operator's behalf). A dashboard chat with the COO, a Telegram conversation
   with the PA, a direct chat with any employee: the operator reading the reply
   and typing the next message is an active session even though no turn is
   running. Read from the session registry's `lastActivity`. A heartbeat armed
   on such a session re-runs it on a timer and bumps that stamp, so it reads as
   the operator for `idleMinutes` after each beat — the safe direction.
2. A Jinn interactive Claude session (the dashboard's CLI mode) wrote its
   statusline snapshot — the recorder the gateway installs in those sessions
   writes on every turn, so the newest snapshot's mtime is the last moment the
   operator drove Claude that way.
3. The five-hour window's used share rose by `operatorActivity.usageDeltaPercent`
   (default 2, floor 1) or more between two **ticks'** readings of the same
   window, while no Jinn session was active in between. Usage the system did
   not spend is the operator's, on whatever machine they spent it — this is the
   one signal that reaches a Claude Code session outside Jinn. It fails towards
   caution: a Jinn session too brief to be seen between two ticks can read as
   the operator, which backs the loop off. A preview never advances this
   signal's reference reading; only a tick does.

**A session holds engine capacity** — the `maxActiveSessions` guard — when it
is mid-turn or queued (transport `running`/`queued`) or parked on a gate
(`waiting`), on any engine. Jinn cannot see interactive Claude Code use outside
itself except through signal 2.

## What it never does

- Run while `gateway.idleCapacity.enabled` is not `true` (the default).
- Start anything without a usable reading: an unsupported, errored or stale
  reading, or one that lacks the five-hour or weekly window or names a reset
  that is not still ahead, is a reason to hold, never a reason to go.
- Start while a window is above the tier's ceiling. Every weekly bucket the
  account reports, per-model ones included, must be under the weekly ceiling.
- Start while more sessions hold engine capacity than the tier allows.
- Start more than the tier's `maxDispatchesPerWindow` Todos in one five-hour
  window (counted by the window's reset time), or more than one per tick.
- Touch a Todo that opted out (`no-auto-start` label or `autoStart: false`),
  whose next attempt is pinned to a non-Claude engine, or has an approval
  pending.
- Touch anything outside `backlog`. A parked Todo is `blocked`, so it is not a
  candidate until its park runs out and it is back in the queue — see
  [Parking date-gated work](#parking-date-gated-work).

## What the ceilings are — and are not

A ceiling is a **gate on starting**, re-checked against the live account
before every start. It is **not a bound on consumption**. Once a Todo is
started its session runs to completion, and a senior-developer Opus session
can run for one to three hours: a start at the end of a five-hour window can
carry the window past its ceiling and spend the front of the next one. Two
things bound the damage — the per-window start cap, and the fact that the
next tick's ceiling check holds once the window is over — but nothing stops a
running session on the ceiling. Set the ceilings with that in mind: the
overnight floor of 15% is a floor on *starting*, and a start at 84% can still
run the window to the top. Stop-on-ceiling (interrupting a started session
when the window crosses a line) is a deliberate omission in this version and
is recorded as an open decision in the spec.

The downstream assignee's engine is likewise not constrained. The Dispatcher is
told the start exists to use Claude allowance and to prefer a Claude-engine
employee, and Todos pinned to another engine are skipped, but the Dispatcher's
routing is its own judgement.

## Configuration

```yaml
gateway:
  idleCapacity:
    enabled: true                    # default false
    intervalMinutes: 10              # how often the reading is re-taken
    timezone: Europe/London          # the zone the quiet hours are read in
    quietHours: { start: "01:00", end: "06:00" }   # may wrap midnight
    operatorActivity:
      idleMinutes: 30                # how long the operator counts as live
      usageDeltaPercent: 2           # 5h usage rising this much outside Jinn = operator
    tiers:
      overnight:
        enabled: true
        fiveHour: { maxUsedPercent: 85, lookaheadMinutes: 300 }
        sevenDay: { maxUsedPercent: 85, lookaheadMinutes: 1440 }
        maxDispatchesPerWindow: 3
        maxActiveSessions: 1
      daytime:
        fiveHour: { maxUsedPercent: 50, lookaheadMinutes: 120 }
        sevenDay: { maxUsedPercent: 75, lookaheadMinutes: 1440 }
        maxDispatchesPerWindow: 2
        maxActiveSessions: 1
      interactive:
        fiveHour: { maxUsedPercent: 20, lookaheadMinutes: 30 }
        sevenDay: { maxUsedPercent: 60, lookaheadMinutes: 1440 }
        maxDispatchesPerWindow: 1
        maxActiveSessions: 1
    requireLabel: null               # e.g. idle-ok — opt-in mode
```

The values shown are the defaults; any key may be omitted. Config is
hot-reloaded: switching the feature on, or changing a tier, takes effect on
the next tick without a restart. A malformed block is refused at config load
with the key named.

The dashboard's **Auto-Dispatch** page edits the same block: every key above
is a control there, pre-filled with the values the loop is using (defaults
included). A save writes the whole block through `PUT /api/config`, the same
path the Settings page uses, carrying the file's revision so a hand edit made
under an open page is refused rather than overwritten; a value the validator
refuses is shown against its field and never reaches the file. Toggles apply
on click, fields on blur or Enter — never per keystroke, since a prefix of
`30` idle minutes or of `Europe/London` is a different policy. The page also
shows a switch on each Todo's page, **Auto-start**, which sets the Todo's
`dispatchConfig.autoStart`; off keeps the loop away from that one Todo
whatever the policy says, as the `no-auto-start` label does.

Two triggers, both inside the tier's ceilings:

1. the five-hour window resets within the tier's `fiveHour.lookaheadMinutes`
   with its used share at or below `fiveHour.maxUsedPercent`;
2. the seven-day window resets within `sevenDay.lookaheadMinutes` with its used
   share at or below `sevenDay.maxUsedPercent` — the five-hour ceiling still
   applies, because that is the interactive headroom whatever the week says.

Eligible backlog Todos are tried highest priority first, then oldest first.
Set `requireLabel` to make it opt-in: only backlog Todos carrying that label
are considered. Date-gated work ("run on/after …") has to be parked — the loop
cannot read a date out of a title.

## Parking date-gated work

The loop starts whatever is in `backlog`, so work that must not run before a
date has to be out of `backlog` until then. That is a **park**: a plain block
carrying `parkedUntil`.

```
update_work_item { id: "TST-19", status: "blocked", note: "run on/after the 1st",
                   parkedUntil: "2026-10-01T00:00:00Z" }
```

- **The status must be `blocked`.** `parkedUntil` belongs to the stop, and any
  move that does not stop the Todo deletes it on the same write — so the
  gateway refuses it (400) on a move to `backlog`, `executing` or `in_review` rather than report a park that is already gone.
- **Leave `blockKind` unset** (it means `needs_input`). A `dependency` block
  re-queues the Todo to `backlog` on the same write, so it cannot
  carry a park and is refused with one. Avoid `transient` too: it is the kind
  the reconciler writes for a failed attempt, and recurrences are counted per
  kind, so a park would share the counter that ends a failure loop.
- **To move the date, send the same move again** with the new `parkedUntil`. A
  hint (`unblockHint`) already on the stop is kept unless restated.
- **It un-parks by itself.** Once `parkedUntil` has passed, the work-item
  reconciler (at boot, then every 20 seconds) moves the Todo back to the queue
  the way a `dependency` block would — to `backlog`, keeping its assignee,
  where this loop or a dispatch can start it — and records the move with actor
  `park-expiry`.
  Nobody has to remember to come back for it. The attempts it ran before the
  park no longer count as evidence of its status, so it is not pulled straight
  into `in_review` or back into `blocked` by an old session receipt.
- Until then the board shows it as waiting on a clock, not on you, and it stays
  out of the needs-you queue.

Do not use `dueAt` for this. Elsewhere in the ledger it means a deadline, and
the loop does not read it.

Parking uses the ordinary block, so it counts toward the block-loop breaker: a
Todo blocked with the same kind three times without being finished in between
is escalated instead: it stays in `blocked`, recorded as an escalation to the
operator. A Todo parked again and again is therefore escalated on its third
park, the same as one blocked again and again.

## Observing it

- `GET /api/idle-capacity` — what the next tick would do and why: the resolved
  policy, the tier and the evidence behind it (whether the operator is live,
  from which signal, whether the clock is in the quiet hours), the live verdict
  against the account's windows including each window's reset time and
  minutes to go, the eligible backlog in order, the Todos passed over with the
  reason, and how many starts are charged to the current five-hour window.
  Read-only; it never starts anything.
- Every start leaves a system comment on the Todo (author `idle-capacity`)
  quoting the tier and reading it acted on, the Dispatcher session it started,
  and the count against the window cap.
- The gateway log carries one `Idle-capacity: started …` line per start.
- The **Auto-Dispatch** page shows the preview as a card, lists every start
  the loop has made (read back from those comments, newest first, with the
  Todo's current status), and graphs the account's five-hour and weekly used
  share over the last twelve hours with the starts and window resets marked.
  The gateway keeps the readings it makes (`tmp/engine-limits/claude-usage-history.json`,
  one per five minutes, a week deep; a reading without a reset instant is not
  kept, as the loop does not act on one). Above the graph the page projects
  where each window is heading — a straight line at the rate of the current
  window's readings, from the last reading to the reset, against the tier's
  start gate — and leads with the weekly verdict, worst bucket first. The
  projection is the page's arithmetic over served readings: the gateway
  computes, stores and logs none, and the loop never reads one. It needs
  three readings before it says anything — over half an hour for the
  five-hour window, over six hours for a weekly bucket (a single 1% step over
  half an hour would read as a week exhausted by tonight) — and it says what
  it is ("linear, at the last 2 h rate"). A window whose reset has passed, or
  a per-model bucket the account has stopped reporting, gets no verdict.
- `GET /api/idle-capacity/history`, `/policy` and `/usage` are the page's
  reads; all are read-only.
- On first enablement, watch one overnight through the preview. An account
  that has been idle long enough to have no five-hour window open reports no
  reset for it, and the loop holds (a missing reset is never a reason to go)
  until something opens a window. That is consistent with "capacity about to
  lapse" — there is none — but it means a fully idle night starts nothing.

## Engines

**Claude** is the only engine with a windowed account quota to read. The
collector (`shared/engine-limits-claude.ts`) queries the OAuth usage API the
CLI's `/usage` screen uses, falling back to the CLI's statusline snapshot; it
was already a library function, a CLI (`jinn limits --json --engine claude`) and
an HTTP route (`GET /api/engine-limits?engine=claude`) before this feature, and
the loop calls the function directly. Each window carries `resetsAt`, so the
loop reads the real reset rather than assuming a cadence — the account's
five-hour-window pattern never needs to be inferred.

**OpenCode** is not an input to this loop. OpenCode routes to whatever provider
its own config names (here OpenCode Go, falling back to OpenRouter
pay-per-token). Neither the CLI nor the Go provider publishes an account quota
the CLI can read., `engines.opencode.usageLimits` meters jinn's
own opencode spend against Go's documented windows (docs/engines-opencode.md).
That is enough to stop routing work onto a spent opencode. It is not a reading
of the account's unused allowance, so the loop still acts only on Claude's.
Without that setting, `jinn limits` says opencode has no quota to read, rather
than "no collector is registered".
