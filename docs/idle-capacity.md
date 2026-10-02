# The board walk: readiness and idle-capacity dispatch

The board walk is a scheduled pass over the Todo board. It ships on by default, and each tick decides two things:

1. **What is ready.** A Todo's gates are usually written in prose: "not before the 10th", "after #18 merges", a `blocks` relation. The walk releases a `blocked` Todo whose gates are met, parks a Todo whose only gate is a plain date, and flags a stuck Todo once.
2. **What to start.** It reads the account's usage, reset times and predictions, then decides whether spare capacity should start a ready backlog Todo, and which one. It starts it through the same Todo Dispatcher the board's dispatch button uses.

It replaced the numeric idle-capacity loop (`gateway.idleCapacity`) and is the only timer that starts work. Everything it does is ruled by one file the operator edits, `$JINN_HOME/board-walk.md`.

## Why a model turn, when this used to be a code loop

An earlier version of this page argued for a code loop. A cron job is a prompt run by an engine, so it spends the capacity it measures, to answer what was then a handful of numeric comparisons.

The question is no longer numeric. Gates are prose, and the operator wants to say what they like dispatched and when, in words: "never while I'm working", "Codex can take docs work any time". Two separate LLM schedulers, one for readiness and one for dispatch, would race each other. So one turn does both:

- **Sonnet, hourly by default.** One turn per tick, with no tool calls: the board and the snapshot arrive in the prompt, and the answer is one JSON object.
- **Nothing open, no turn.** A tick on a board with no open Todos spends nothing.
- **Off when you say so.** `enabled: false` stops every tick.

## The rules file

`board-walk.md` is seeded from the template on `jinn setup` and at every gateway boot when it is missing. It is **never overwritten**: an upgrade leaves an edited file alone. It is re-read on every tick, and the scheduler re-reads it once a minute, so edits take effect without a restart.

The **frontmatter** holds the mechanical settings:

```yaml
enabled: true            # false stops everything
schedule: "0 * * * *"    # cron expression; hourly by default
timezone: ""             # for the schedule and "local time"; empty = the host's zone
employee: assistant      # whose engine runs the walk's turn
model: sonnet            # model for that turn; empty = the employee's own
actions:                 # hard switches, enforced by the gateway
  release: true
  park: true
  flagStuck: true
  dispatch: true
  comment: true
```

The **body** is prose, one section per default behaviour:

- Gates
- Release
- Park plain date gates
- Flag stuck Todos
- Comments
- Dispatch
- Your own rules

The shipped Dispatch section restates the old numeric policy in plain English:

- three situations (overnight, daytime, operator live), each with its own ceilings and lookahead;
- quiet hours;
- the operator-activity signals;
- one start per tick, and the starts per five-hour window;
- no start while a session holds capacity;
- priority first, then the oldest.

Change any of it. Write "don't" to switch a behaviour off, or add rules in "Your own rules". A section you delete falls back to the shipped default.

**Switches are the only certain "off".** The prose is read by a model; the switches are read by the gateway. With `actions.dispatch: false`, every start the walk asks for is refused, whatever the prose says, while readiness keeps running. With `enabled: false`, nothing runs at all. The prose can narrow what a switch allows; it cannot widen it.

A rules file that does not parse holds the walk; it never runs on guesses. The same applies to a bad switch value, a bad schedule or zone, or a missing file. The problem is shown on the Auto-Dispatch page and logged on each tick.

## What one tick does

1. **Read** `board-walk.md`. Stop if it is switched off or broken.
2. **Build the board.** Every open Todo (`backlog`, `blocked`, `executing`) goes in, with:
   - title, body, acceptance criteria, labels, dates and priority;
   - its last comments;
   - its relations, with each related Todo's current status;
   - its stop cause (block kind, park date, unblock hint);
   - whether it refuses automatic starts;
   - what is running on it;
   - the live state of every GitHub pull request or issue it links to, looked up with `gh`. A link that cannot be resolved is `unknown`, and an unknown gate is treated as not met.

   Long text is truncated, and the board is capped so it fits one prompt.
3. **Build the capacity snapshot** (below).
4. **Ask the model.** One turn, routed as a session to the configured employee with the configured model. The session's key starts with `board-walk:`, and it is visible in Chats like any other session.
5. **Carry out the answer.** The gateway checks every decision against the switches and the Todo's state at that moment:
   - **release:** a `blocked` Todo goes back to `backlog`, keeping its assignee, with a comment giving the reason.
   - **park:** a `backlog` or `blocked` Todo goes to `blocked` with `parkedUntil` set. The park expiry puts it back in the queue when the date passes (see below). An `executing` Todo is never parked.
   - **flag:** a stuck Todo gets one comment. Each stuck episode is raised once, across ticks. If the Todo moves and later gets stuck again, that is a new episode.
   - **start:** a ready `backlog` Todo is handed to the Todo Dispatcher, with the walk's reason and any engine preference added to the Dispatcher's prompt.

     Some starts are refused in code, whatever the model asks: a Todo with the `no-auto-start` label, a Todo whose dispatch config says `autoStart: false` (the **Auto-start** switch on a Todo's page), and a Todo assigned to the operator. These are choices the operator made per Todo; they are not capacity limits.
6. **Log the tick** to `logs/board-walk.jsonl`. Every decision is logged with the model's reason and what the gateway did with it, refusals included. A tick that starts nothing logs why. The gateway log gets one line per tick.

A tick that fails starts nothing and moves nothing: an engine error, an answer with no readable JSON, or an answer with no `dispatch.reason`. The failure is logged. Ticks never overlap: a scheduled fire that lands while one is running is logged as `busy` and skipped.

## The capacity snapshot

The prompt carries one structure with readings and predictions, and no verdict:

- **Every engine with a reading.** Claude, Codex, and opencode when `engines.opencode.usageLimits` is set. Each has its windows (used share, reset time, minutes to reset), whether it is recorded as exhausted, how many sessions on it hold capacity now, and the sessions started on it in the current five-hour window, broken down by what started them.

  Engines the registry knows but that have no usable reading are listed by name, with the reason.
- **Predictions for the Claude windows.** These come from the retained readings (`tmp/engine-limits/claude-usage-history.json`): the rate, the share expected at the reset, the share expected to lapse unused, and the exhaustion time if it comes before the reset. A prediction needs three readings, over half an hour for the five-hour window and six hours for a weekly one. Otherwise it says why it has none.
- **The operator-activity signals.** These are given as times and deltas, not as a verdict:
  - when the newest activity was on a session the operator drives (top-level, not cron, not a system employee);
  - when a Jinn Claude session the operator drives last wrote its statusline. Every Jinn Claude session writes one, including the walk's own turn and delegated work, so only the operator's own sessions count;
  - how much the Claude five-hour usage has risen since the previous tick's reading, and whether any Jinn session ran in between.

  The previous reading is taken after the walk's own turn, so the walk's own spend is not counted as the operator's. Whether all of this means "the operator is live" is the rules file's call.
- **The local time, weekday and zone.**

## Parking date-gated work

A park is a `blocked` Todo carrying `parkedUntil`. The walk parks plain date gates itself when `park` is on, and anyone can park by hand:

```
update_work_item { id: "TST-19", status: "blocked", note: "run on/after the 1st",
                   parkedUntil: "2026-10-01T00:00:00Z" }
```

- **The status must be `blocked`.** A move that does not stop the Todo deletes the park, so the gateway refuses `parkedUntil` on any other move.
- **It un-parks by itself.** Once the date passes, the work-item reconciler moves the Todo back to `backlog`, keeping its assignee, with actor `park-expiry`. It runs at boot and then every 20 seconds.
- **Parks count toward the block-loop breaker.** The walk parks with `blockKind: transient`, so a Todo parked again and again is escalated on its third park, like any repeated block.

## Upgrading from `gateway.idleCapacity`

The numeric loop and its config are gone. At the first boot of this version:

- **No `board-walk.md` yet:** it is created. A `gateway.idleCapacity` block is turned into equivalent prose in its Dispatch section:
  - every tier's ceilings, lookaheads, starts per window and concurrency;
  - a switched-off tier;
  - quiet hours and the operator-activity thresholds;
  - `requireLabel`;
  - the timezone;
  - the tick interval, as a cron schedule, when the block set one. Otherwise the schedule is hourly.

  If the block did not enable the old loop, `actions.dispatch` is set to `false`. The board walk ships on, but an operator who had automatic starts off never agreed to them.
- **In every case,** the block is removed from `config.yaml`. A copy of the file as it was is kept beside it, as `config.yaml.pre-board-walk-<time>`.
- **`board-walk.md` already exists:** the block is removed without being merged, and the boot log says so. Copy any setting you still want into the Dispatch section by hand.

Without a block, an upgrade seeds the stock file, **with dispatch on**. That is a change from the old default, where the loop was off. Set `actions.dispatch: false` before upgrading if you do not want automatic starts.

## Observing it

The **Auto-Dispatch** page is read-only. It shows:

- **The board walk:** whether it is scheduled, its schedule, zone, employee and model, which switches are off, any problems with the rules file, and the last ten ticks with every Todo they touched and why.
- **Where the Claude allowance is heading:** the weekly verdict leads, worst bucket first, with the five-hour projection and a twelve-hour graph beneath it. The graph marks window resets and every session started on Claude; the starts the board walk made are marked in green.
- **Sessions started this week:** every session started on each engine, newest first, whatever started it (the board walk, the dispatch button, quick capture, cron, a delegation, a chat). It is read from the session registry, one engine at a time. A Dispatcher session the walk started carries `transportMeta.startedBy: board-walk`; that is how the registry tells it apart from a manual dispatch.

The HTTP routes:

- `GET /api/board-walk`: the rules file's settings and problems, whether the walk is scheduled or running, and the last tick.
- `GET /api/board-walk/ticks?limit=`: the tick log, newest first.
- `POST /api/board-walk/tick`: run a tick now. Operator only. `?wait=1` waits for the result; otherwise it answers 202 at once.
- `GET /api/auto-dispatch/sessions?hours=&engine=`: sessions started, with what started each one.
- `GET /api/auto-dispatch/usage?hours=`: the retained Claude readings.

## What a start does not bound

A start is a decision made against the readings of that moment. It does not bound consumption. A started session runs to completion, and a long one can carry a window past whatever ceiling the rules name. The rules file says when to start; nothing stops a running session on a ceiling. Write the ceilings with that in mind.
