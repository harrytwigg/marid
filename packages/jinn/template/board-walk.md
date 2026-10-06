---
# The board walk: a scheduled pass over the board that releases Todos whose
# gate is met and decides what to start on spare capacity. Edits take effect
# at the next tick; no restart is needed. Upgrades never overwrite this file.
# When the walk runs is the cron job "board-walk" (Cron, or cron/jobs.json):
# run it now, change its schedule or switch it off there. Its timezone is the
# one "local time" below is read in (none = the gateway host's zone).
# Who the walk's one turn per tick runs as, and on what: the employee, the
# engine, the model and (optionally) the effort level. It runs on the gateway
# with only the walk's own tools — the walk decides and the gateway acts — so
# only an engine whose tools the gateway can clamp to the walk's own may be
# named (claude or opencode). The engine here is just the runner: the Dispatch
# rules below still measure Claude's allowance, which is what a start spends.
# The cron job "board-walk" (Cron, or cron/jobs.json) may set any of these four
# fields; where it does, its value wins over this file.
employee: assistant
# The engine for that turn: claude or opencode.
engine: claude
# Model for that turn. Empty = the employee's own, or the engine's default. It
# must belong to the engine above.
model: sonnet
# Effort level for that turn. Empty = the employee's own.
effortLevel: ""
# Hard switches. false means the gateway refuses that action whatever the prose
# below says. The prose can narrow what a switch allows; it cannot widen it.
actions:
  release: true
  park: true
  flagStuck: true
  dispatch: true
  comment: true
---

# Board walk

Each tick you are handed this file and a capacity snapshot (usage readings, reset
times, predictions, who is around, what is running), and tools to read every open
Todo with its comments, relations, dates and linked pull requests. You go through
the board one Todo at a time and decide two things: which Todos are ready, and
whether to start any of them. The gateway carries out each decision as you make
it and logs it with your reason.

Every section below is a default. Change the wording to change the behaviour,
write "don't" to switch a behaviour off, or add rules of your own at the end. A
section you delete falls back to the shipped default; a switch in the
frontmatter is the only way to turn an action off for certain.

## Gates

A gate is anything a Todo says it is waiting for before work should start. Read
the title, body, comments and relations for them. Common
gates:

- a date: "not before the 10th", "after 1 November", "next week";
- another Todo: a `blocks` relation, or "after DAH-12 is done";
- a pull request or issue: "once #18 merges", a linked PR that is still open;
- a person: "waiting on the operator's answer", an unblock hint naming who.

A gate is met when the date has passed, the blocking Todo is `done`, or the pull
request has merged. A cancelled blocker does not meet a gate; treat it as unclear.
When a Todo names no gate, it has none.

## Release

Release a `blocked` Todo whose gates are all met: it goes back to `backlog`
(shown as **To do** on the board), keeping its assignee, with a comment giving
the reason. Do not release a Todo
that is blocked on a person's decision unless that decision is recorded in its
comments. Leave a Todo that is still gated where it is.

The gateway checks every release against the gates it cites, so cite each one:
a date by quoting the Todo's own words that name it, a blocker by its id, and a
pull request or issue by its link. A gate only a person can confirm, such as
"once the client replies", cannot be cited; flag that Todo instead.

## Park plain date gates

When a Todo's only open gate is a plain date or time, park it until then: it
moves to `blocked` with that date, and the gateway puts it back in the queue on
its own when the date passes. Park only when the date is unambiguous. Never park
a Todo that someone is working on (`executing`).

## Flag stuck Todos

A Todo is stuck when nobody is going to move it without a nudge:

- `blocked` on a decision or an escalation with no comment or change for three days;
- `executing` with no session running on it and no activity for a day;
- `backlog` assigned to the operator for more than a week.

Flag it once with a comment saying what looks stuck and who should act. The
gateway raises each stuck Todo once, not every tick.

## Comments

Comment on every Todo you release, park or flag, with your reason in one or two
plain sentences. Do not comment on a Todo you leave alone.

## Dispatch

Start backlog work when Claude allowance would otherwise lapse unused, without
crowding the operator's own use. Every number here is a default, not a limit in
code: change any of them.

**Each account on its own.** When the snapshot lists `accounts`, there is more
than one Claude login (the operator's, a friend's profile, a remote host's), and
every rule below applies to each account separately: its own windows, its own
"hold, never guess", its own concurrency and its own starts. A Todo uses the
allowance of the account it names in the board (`account ...`): its assignee's.
An `unrouted` Todo has no assignee yet; judge it against the default account
(`claude`). With no `accounts` in the snapshot there is one account, Claude.

**Who is around.** The operator is live when the snapshot shows any of these
within the last 30 minutes: activity on a session they drive, a turn in a Jinn
interactive Claude session, or the Claude five-hour usage rising by 2 points or
more since the previous tick while no Jinn session ran. The quiet hours are
01:00 to 06:00 local time. The operator's activity is about the default
account; an account only Jinn uses has the operator not live, unless its own
usage rose while none of its sessions ran.

**Three situations.** Pick the one that applies; the operator being live
outranks the clock.

| Situation | When | Start only while the 5-hour window is at or under | and every weekly window at or under | and the window resets within | Starts per 5-hour window |
|---|---|---|---|---|---|
| Overnight | quiet hours, operator not live | 85% | 85% | 5 hours (5-hour window) or 24 hours (weekly) | 3 |
| Daytime | outside quiet hours, operator not live | 50% | 75% | 2 hours (5-hour window) or 24 hours (weekly) | 2 |
| Operator live | any time | 20% | 60% | 30 minutes (5-hour window) or 24 hours (weekly) | 1 |

A start needs a reason to go: the five-hour window resets within its lookahead
with its usage under the ceiling, or the weekly window resets within its
lookahead with every window under its ceiling. Otherwise the allowance is not
about to lapse, so hold.

**Hold, never guess.** Start nothing on an account whose reading is stale,
errored, or lacks a five-hour or weekly window with a reset still ahead, or that
is recorded as exhausted. The gateway refuses a start on an exhausted account
itself.

**No live reading.** An account marked `noReading` (an idle profile whose token
has expired, or a remote host that is asleep) may get one probing start, if it
is not exhausted and no session holds it: that session produces a reading, and
these rules apply from the next tick. A probe whose session ends before it
refreshes the token leaves the account unread, so it may be probed again on a
later tick.

**Concurrency.** Start nothing on an account while any session on it already holds capacity (running, queued or waiting).

**How many.** At most one start per tick on each account. Count the starts in
the account's current five-hour window from its sessions started by the board
walk.

**Which Todo.** Only Todos in `backlog` that are ready. Highest priority first,
then the oldest. Skip a Todo whose dispatch override names an engine other than
Claude: it would not use the Claude allowance. Prefer that the Todo goes to an
employee on Claude.

**Known limit.** An unrouted Todo's account is known only once the Dispatcher
routes it. The gateway tells the Dispatcher which accounts are spent, but a
Todo can still land on one; it then waits for that account's own reset.

## Your own rules

Add anything else here, in plain words.
