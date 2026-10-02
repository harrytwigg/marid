---
# The board walk: a scheduled pass over the board that releases Todos whose
# gate is met and decides what to start on spare capacity. Edits take effect
# at the next tick; no restart is needed. Upgrades never overwrite this file.
enabled: true
# Cron expression. Hourly, on the hour.
schedule: "0 * * * *"
# IANA zone for the schedule and for "local time" below. Empty = the gateway host's zone.
timezone: ""
# Who the walk's one turn per tick runs as. It always runs on Claude, on the
# gateway, with no tools: the walk decides and the gateway acts.
employee: assistant
# Claude model for that turn. Empty = the employee's own, or Claude's default.
model: sonnet
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

Each tick you are handed this file, a capacity snapshot (usage readings, reset
times, predictions, who is around, what is running) and every open Todo with its
comments, relations, dates and linked pull requests. You decide two things: which
Todos are ready, and whether to start any of them. The gateway carries out what
you decide and logs every decision with your reason.

Every section below is a default. Change the wording to change the behaviour,
write "don't" to switch a behaviour off, or add rules of your own at the end. A
section you delete falls back to the shipped default; a switch in the
frontmatter is the only way to turn an action off for certain.

## Gates

A gate is anything a Todo says it is waiting for before work should start. Read
the title, body, acceptance criteria, comments and relations for them. Common
gates:

- a date: "not before the 10th", "after 1 November", "next week";
- another Todo: a `blocks` relation, or "after DAH-12 is done";
- a pull request or issue: "once #18 merges", a linked PR that is still open;
- a person: "waiting on the operator's answer", an unblock hint naming who.

A gate is met when the date has passed, the blocking Todo is `done`, or the pull
request has merged. A cancelled blocker does not meet a gate; treat it as unclear.
When a Todo names no gate, it has none.

## Release

Release a `blocked` Todo whose gates are all met: it goes back to `backlog`,
keeping its assignee, with a comment giving the reason. Do not release a Todo
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

**Who is around.** The operator is live when the snapshot shows any of these
within the last 30 minutes: activity on a session they drive, a turn in a Jinn
interactive Claude session, or the Claude five-hour usage rising by 2 points or
more since the previous tick while no Jinn session ran. The quiet hours are
01:00 to 06:00 local time.

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

**Hold, never guess.** Start nothing when the Claude reading is missing, stale,
errored, or lacks a five-hour or weekly window with a reset still ahead, or when
Claude is recorded as exhausted.

**Concurrency.** Start nothing while any session already holds engine capacity (running, queued or waiting).

**How many.** At most one start per tick. Count the starts in the current
five-hour window from the snapshot's sessions started by the board walk.

**Which Todo.** Only Todos in `backlog` that are ready. Highest priority first,
then the oldest. Skip a Todo whose dispatch override names an engine other than
Claude: it would not use the Claude allowance. Prefer that the Todo goes to an
employee on Claude.

## Your own rules

Add anything else here, in plain words.
