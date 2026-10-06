# The board walk: readiness and idle-capacity dispatch

The board walk is a scheduled pass over the Todo board. It ships on by default, and each tick decides two things:

1. **What is ready.** A Todo's gates are usually written in prose: "not before the 10th", "after #18 merges", a `blocks` relation. The walk releases a `blocked` Todo whose gates are met, parks a Todo whose only gate is a plain date, and flags a stuck Todo once.
2. **What to start.** It reads the account's usage, reset times and predictions, then decides whether spare capacity should start a ready backlog Todo, and which one. It starts it through the same Todo Dispatcher the board's dispatch button uses.

It replaced the numeric idle-capacity loop (`gateway.idleCapacity`) and is the only timer that starts work. What it does is ruled by one file the operator edits, `$JINN_HOME/board-walk.md`. When it runs is an ordinary cron job, `board-walk`, so it is listed, run, rescheduled and switched off from the normal cron controls.

## Why a model turn, when this used to be a code loop

An earlier version of this page argued for a code loop. A cron job is a prompt run by an engine, so it spends the capacity it measures, to answer what was then a handful of numeric comparisons.

The question is no longer numeric. Gates are prose, and the operator wants to say what they like dispatched and when, in words: "never while I'm working", "Codex can take docs work any time". Two separate LLM schedulers, one for readiness and one for dispatch, would race each other. So one turn does both:

- **Sonnet, hourly by default.** One turn per tick. The rules and the snapshot arrive in the prompt; the model reads the board through five tools of its own and hands over one decision per Todo, which the gateway checks and carries out as it comes.
- **Nothing open, no turn.** A tick on a board with no open Todos spends nothing.
- **Off when you say so.** Disable the `board-walk` cron job and nothing ticks.

## The schedule: the `board-walk` cron job

Every installation has a cron job in `$JINN_HOME/cron/jobs.json`:

```json
{ "id": "board-walk", "name": "Board walk", "enabled": true, "schedule": "0 * * * *", "prompt": "", "action": "board-walk" }
```

`action: "board-walk"` makes the job run a walk tick in the gateway instead of sending a prompt to an engine. Its `prompt` is empty and `delivery` is not used; its `employee`, `engine`, `model` and `effortLevel` are the walk's runner fields, overriding `board-walk.md` where set (see below).

- **Run it now** from the Cron page, `POST /api/cron/board-walk/trigger` or `/cron run board-walk`. A run-now ticks even while the job is disabled, as for any job. `POST /api/board-walk/tick` still works too.
- **Change when it runs** by editing the job's `schedule` (and `timezone`) the way any job's is changed: in `jobs.json` (the gateway reloads it) or with `PUT /api/cron/board-walk`. The job's timezone is also the zone the walk reads "local time" in; with none, the gateway host's.
- **Switch it off** by disabling the job. Deleting it is permanent: the gateway records that it seeded the job once and does not re-create it, so the walk then runs only when started by hand. To bring it back, create a cron job with `"action": "board-walk"`.
- **It never ticks twice.** Only one job may carry the action: the cron API refuses a second one and refuses changing a job's action, and the scheduler skips a hand-edited duplicate. A fire that lands while a tick is still running is logged as `busy` and skipped.
- **Each fire is a cron run** in the job's run history, with the walk turn's session. A failed or invalid-rules tick is an error run; an idle or skipped tick is a success. The walk's own tick log keeps the detail. No Todo is minted per fire, and the cron failure alert is not sent.

The job is added on `jinn setup` and at gateway boot when it has never been seeded. On a fresh install it is hourly and enabled.

## The rules file

`board-walk.md` is seeded from the template on `jinn setup` and at every gateway boot when it is missing. It is **never overwritten** (the one-time move of the schedule, below, is the only edit the gateway makes to it). It is re-read on every tick, so edits take effect without a restart.

The **frontmatter** holds the mechanical settings:

```yaml
employee: assistant      # who the walk's turn runs as
engine: claude           # the engine for that turn: claude or opencode
model: sonnet            # model for that turn; empty = the employee's own, or the engine's default
effortLevel: ""          # effort level for that turn; empty = the employee's own
actions:                 # hard switches, enforced by the gateway
  release: true
  park: true
  flagStuck: true
  dispatch: true
  comment: true
```

The `board-walk` cron job may set the same four runner fields (`employee`, `engine`, `model`, `effortLevel`); where it does, its value wins over the file. Unset on both, the defaults above stand.

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

Change any of it. Write "don't" to switch a behaviour off, or add rules in "Your own rules". A section you delete falls back to the shipped default: the gateway gives the model the shipped section, marked as a default that the operator's own rules override.

**Switches are the only certain "off".** The prose is read by a model; the switches are read by the gateway. With `actions.dispatch: false`, every start the walk asks for is refused, whatever the prose says, while readiness keeps running. With the cron job disabled, nothing runs at all. The prose can narrow what a switch allows; it cannot widen it.

A rules file that does not parse holds the walk; it never runs on guesses. The same applies to a bad switch value or a missing file. The problem is shown on the Auto-Dispatch page and logged on each tick.

## Upgrading from a file that held the schedule

Before the cron job, the frontmatter carried `enabled`, `schedule` and `timezone`. At the first boot of this version, when the job has never been seeded:

- The job is created from those keys: same schedule, same zone, enabled as the file had it. A schedule or zone the old scheduler would not have armed, or an `enabled` that is not true or false, gives a job that is switched off, so the move never starts a walk that was not running. The boot log says what was carried over.
- The three keys, and the stock comments that described them, are taken out of the frontmatter, with a copy of the file kept as `board-walk.md.pre-cron-<time>`. A comment pointing at the cron job takes their place. Nothing below the frontmatter changes. If the rewritten frontmatter cannot be shown to parse to the same settings less those keys, the file is left alone instead.
- Any of the three keys still in the file afterwards is not read. The boot log and the Auto-Dispatch page say so.
- An existing `jobs.json` keeps every job in it. One that does not parse is never rewritten: the job is not added, and the next boot tries again.

## What one tick does

1. **Read** `board-walk.md`. Stop if it is switched off or broken.
2. **Build the capacity snapshot** (below).
3. **Run the walk's turn.** One turn, routed as a session to the configured employee on the configured engine, **on the gateway, with the walk's tools and nothing else**. Its only MCP server is the jinn server serving the `board-walk` toolset, in place of the company toolset and every resolved custom server. The surface is clamped per engine: on Claude the built-ins are switched off (`--tools ""`, `--strict-mcp-config`, and `--no-chrome`, without which the engine's Chrome integration brings its browser tools back); on opencode, whose server mode ignores those flags, the turn runs as a purpose-built agent that allows exactly the board-walk tool names and denies every other tool (`--agent`). On opencode the operator's own MCP servers still load — opencode reads its config and the staged one only merges in — but each of their tools is denied, so none is reachable. Only engines that can be clamped this way may be named. The employee's own engine, host and flags are set aside, and a rate-limited walk turn is never handed to a fallback engine. If the walk's engine is not installed, or is recorded as exhausted, the whole tick is skipped without a turn, readiness included: nothing is released, parked or flagged until it is back, and the reason is logged. The session's key starts with `board-walk:`, and it is visible in Chats like any other session. A walk turn cut off by a gateway restart is not resumed; the next tick replaces it.

   The prompt carries the rules, the snapshot and how to use the tools. The board is not in it: the model reads it, one Todo at a time, through its tools.
   - `walk_board` lists the open Todos, one line each, highest priority first, with what this tick has already decided.
   - `walk_todo` shows one Todo in full: title, labels, dates and priority; its stop cause (block kind, park date, unblock hint); whether it refuses automatic starts; what is running on it; its relations, with each related Todo's current status; the live state of every GitHub pull request or issue it links to, looked up with `gh` (a link that cannot be resolved is `unknown`, and an unknown gate is treated as not met); its body and its newest comments. Long text is cut short and says so.
   - `walk_decide` hands over the decision on one Todo, with the model's reason: release, park, flag or leave. The gateway checks it and carries it out at once (below) and answers with what it did. A decision that cannot be read, or that is refused, changes nothing, and the model may decide that Todo again; a Todo decided and carried out is not decided twice in one tick.
   - `walk_start` starts one backlog Todo through the Todo Dispatcher.
   - `walk_finish` ends the tick with a summary and why the walk started what it started, or nothing.

   The gateway answers these tools only for the running tick's own session, bound by its session capability. Each tick has a budget of tool calls (three per open Todo plus twenty, at most 600); past it every call is refused, and whatever is not decided waits for the next tick. The tick also gives up on its turn after ten minutes, plus fifteen seconds for each open Todo past the twentieth, at most thirty; the turn is stopped, and the decisions already carried out stand.
4. **Carry out each decision as it comes.** The gateway checks every decision against the switches and the Todo's state at that moment:
   - **release:** a `blocked` Todo goes back to `backlog`, keeping its assignee, with a comment giving the reason. A release must cite every gate it relies on, and the gateway checks each one itself before the Todo moves: a date gate quotes the Todo's own words naming the date (found in its title, body or comments, the walk's own comments excluded), the quote must contain that date (as `2026-11-01`, `1 November`, `Nov 1` or `the 1st`, the last matched on the day of the month alone; a numeric `01/11` is ambiguous and not accepted), and the date has passed; the blocker is `done` and is named by this Todo (a `blocks` relation or its id in the text); the pull request linked from this Todo has merged, or the issue has closed. A release whose gates cannot be checked is refused, so a Todo waiting on a person's decision is flagged rather than released.
   - **park:** a `backlog` or `blocked` Todo goes to `blocked` with `parkedUntil` set. The park expiry puts it back in the queue when the date passes (see below). An `executing` Todo is never parked. A `blocked` Todo is re-parked only when its stop is already a clock-wait (block kind `transient`), and it keeps its unblock hint. A Todo stopped for a person is never parked, because a park releases itself on its date and would dissolve the wait; it is released instead, once its gate is met.
   - **The operator's Todos are theirs.** A Todo assigned to the operator, stopped with the operator named as who must act, or holding an approval question carried over from the retired approvals, is never released or parked by the walk, whatever the model asks. It may still be flagged as stuck.
   - **flag:** a stuck Todo gets one comment. Each stuck episode is raised once, across ticks. If the Todo moves and later gets stuck again, that is a new episode.
   - **start:** a ready `backlog` Todo is handed to the Todo Dispatcher, with the walk's reason and any engine preference added to the Dispatcher's prompt.

     Some starts are refused in code, whatever the model asks: a Todo whose dispatch config says `autoStart: false` (the **Auto-start** switch on a Todo's page), and a Todo assigned to the operator. These are choices the operator made per Todo; they are not capacity limits. `autoStart: false` is the only per-Todo opt-out. The `no-auto-start` label that once did the same is retired: at boot the gateway sets `autoStart: false` on every Todo still carrying it, removes the label from them, and deletes it.
5. **Log the tick** to `logs/board-walk.jsonl`. Every open Todo gets one entry: the decision carried out, the refusal it last got, or that it got no decision. Every other refusal is logged too, with the model's reason and why the gateway refused it. A tick that starts nothing logs why. The gateway log gets one line per tick.

A tick whose turn fails (an engine error, or a turn that does not finish in time) is logged as failed, with the engine's own reason, and with the decisions it carried out before it stopped. Ticks never overlap: a scheduled fire that lands while one is running is logged as `busy` and skipped.

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
- **Every Claude account, when there is more than one** (`accounts`): a local named profile or a remote host's login beside the operator's own (see `docs/org.md`, "Claude accounts"). Each has its label and where it runs, its employees, its windows and predictions from its own history, whether it is recorded as exhausted, `noReading` when there is no live reading (an expired token on an idle profile, or a remote host asleep), the sessions on it holding capacity, the starts on it in its own five-hour window, and its usage since the previous tick. A start the walk made counts on the account of the Todo it started, not on the Dispatcher's. With one account the key is absent and the snapshot is exactly as before.
- **The local time, weekday and zone.**

## Several Claude accounts

When more than one Claude account is in use, the walk judges each on its own:

- `walk_board` and `walk_todo` name the account each backlog Todo would run on: its assignee's (the assignee's engine, or the Todo's dispatch override, and the login that employee runs as), or `unrouted` for an unassigned Todo, which is judged against the default account.
- **The gate is in code.** A start whose account is recorded at its limit is refused, whatever the model asks. An unrouted start is refused while the default account is spent.
- **The Dispatcher is told** which accounts are spent, as it is told a preferred engine, so it can route an unassigned Todo elsewhere. That is advice: an unrouted Todo's account is known only once it is routed, so a child can still land on a spent account. It then waits for that account's own reset, not the operator's.
- **One probing start** for an account with no live reading, when it is not exhausted and nothing holds it. That session refreshes the token and produces a reading. A probe whose session ends before it refreshes the token leaves the account unread, so it may be probed again on a later tick, at most once per tick per account.
- **The walk's own turn** runs on its runner's account: the configured employee's login on the configured engine. When that account is exhausted the tick is skipped, as before, and every other account's work waits too. A walk turn never changes engine or account. To keep ticking while the operator's account is spent, point the runner at another engine in `board-walk.md` (or the cron job's runner fields).

The shipped `board-walk.md` states every Dispatch rule per account. An instance's own file is never rewritten, so an older copy keeps its single-account wording until the operator reconciles it.

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
  - the timezone, which goes to the `board-walk` cron job.

  The old tick interval is **not** carried over: it paced a code loop whose ticks cost nothing, and every tick is now a model turn over the whole board. The schedule stays hourly, and the boot log says so. Change the cron job's schedule if you want another cadence.

  If the block did not enable the old loop, `actions.dispatch` is set to `false`. The board walk ships on, but an operator who had automatic starts off never agreed to them.
- **In every case,** the block is removed from `config.yaml`. A copy of the file as it was is kept beside it, as `config.yaml.pre-board-walk-<time>`.
- **`board-walk.md` already exists:** the block is removed without being merged, and the boot log says so. Copy any setting you still want into the Dispatch section by hand.

Without a block, an upgrade seeds the stock file, **with dispatch on**. That is a change from the old default, where the loop was off. Set `actions.dispatch: false` before upgrading if you do not want automatic starts.

## Observing it

The **Auto-Dispatch** page is read-only. It shows:

- **The board walk:** whether its cron job is scheduled (armed by the cron scheduler), switched off, not valid or missing, its schedule and zone with a link to the job, the employee and model, which switches are off, any retired keys left in the file, any problems with the rules file, and the last ten ticks with every Todo they touched and why.
- **Where the Claude allowance is heading:** the weekly verdict leads, worst bucket first, with the five-hour projection and a twelve-hour graph beneath it. The graph marks window resets and every session started on Claude; the starts the board walk made are marked in green.
- **Sessions started this week:** every session started on each engine, newest first, whatever started it (the board walk, the dispatch button, quick capture, cron, a delegation, a chat). It is read from the session registry, one engine at a time. A Dispatcher session the walk started carries `transportMeta.startedBy: board-walk`; that is how the registry tells it apart from a manual dispatch.

The HTTP routes:

- `GET /api/board-walk`: the rules file's settings, problems and retired keys, the cron job that schedules the walk (`job`: the one the scheduler armed, else the one on file, or `null`), whether a job is armed (`scheduled`) or a tick is running, and the last tick.
- `GET /api/board-walk/ticks?limit=`: the tick log, newest first.
- `POST /api/board-walk/tick`: run a tick now. Operator only. `?wait=1` waits for the result; otherwise it answers 202 at once.
- `GET /api/auto-dispatch/sessions?hours=&engine=`: sessions started, with what started each one.
- `GET /api/auto-dispatch/usage?hours=`: the retained Claude readings.

## What a start does not bound

A start is a decision made against the readings of that moment. It does not bound consumption. A started session runs to completion, and a long one can carry a window past whatever ceiling the rules name. The rules file says when to start; nothing stops a running session on a ceiling. Write the ceilings with that in mind.
