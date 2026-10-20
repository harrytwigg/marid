# Feature Specification: Todo-Tree Wake, Child-Watch Heartbeat, Parent-Addressed Review

**Feature Branch**: `feat/todo-tree-wake`

**Created**: 2026-10-20

**Status**: Design. Built in three parts (A, B, C below) on branches stacked on this one.

## Problem

An employee splits its Todo into child Todos, but the parent's owner often never learns
the children finished:

- Parents are woken session to session only. `notifyParentSessionAndWait`
  (`sessions/callbacks.ts`) returns early when the child session has no reporting parent.
  A child Todo made with `create_work_item { parentId }` and started by the board walk or
  `dispatch_work_item` has no reporting parent session, so its completion wakes nobody.
- `hasOpenDelegations` (`work-items/open-delegations.ts`) counts only `executing`
  sub-tasks and in-flight child sessions. Once a child reaches `in_review` or `done` the
  parent looks idle to the stall check, and nothing tells it the child landed.
- The only safety net is an instruction telling orchestrators to arm an hourly heartbeat
  themselves. It is voluntary and regularly skipped.
- Every child moved to `in_review` lands on the operator's review desk, even when an
  employee owns the parent and is the one who has to integrate it.

## Goal

A parent Todo's owner is reliably woken when any child Todo settles, whoever started the
child, and carries the tree to completion. Only the root goes to the operator.

## Terms

- **Settled**: a Todo status in `in_review`, `blocked`, `done`, `cancelled`.
- **Open child**: a child Todo in `backlog` or `executing`.
- **Parent owner**: the parent Todo's assignee, when that is an employee in the org
  (not the operator, not empty).
- **Parent owner session**: resolved at wake time, first match wins:
  1. the parent owner's newest messageable session linked to execute the parent
     (`isExecutionAttempt`, `canMessageSession`, held by the assignee);
  2. `owningEmployeeSession(parent, assignee)` (`work-items/todo-owner-session.ts`).

  An `idle` or `interrupted` session is messageable: a message starts a turn on it, which
  is how a stopped owner is resumed. An `error`, archived or missing session is not.

## Part A: Todo-tree wake

1. **Record, atomically.** Inside `transition()`'s transaction, when the Todo has a
   `parentId`, `to` is settled and `to !== from`, insert a row into a new additive table:

   ```sql
   CREATE TABLE IF NOT EXISTS work_item_child_settles (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     parent_id    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
     child_id     TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
     event_id     TEXT NOT NULL UNIQUE,
     from_status  TEXT NOT NULL,
     to_status    TEXT NOT NULL,
     actor        TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     flushed_at   TEXT,
     outcome      TEXT,          -- woken | deduped | redispatched | recorded
     delivery_id  TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_child_settles_pending
     ON work_item_child_settles(parent_id) WHERE flushed_at IS NULL;
   ```

   A rollback drops the row with the move. A crash after commit leaves the row pending,
   and the sweep (step 3) picks it up.

2. **Batch.** After commit, schedule a flush of that parent at
   `CHILD_SETTLE_BATCH_MS` (10 s) after its oldest pending row. The window is fixed from
   the first row, not reset by later ones, so a stream of settles cannot starve the wake.
   Every settle inside the window goes out in one wake.

3. **Sweep.** On startup and every 60 s, flush every parent whose oldest pending row is
   older than the window. This is what makes the wake durable across restarts.

4. **Flush** (one transaction per parent, then delivery after commit):
   - **Parent closed or in `backlog`/`in_review`**: mark rows `recorded`; no wake.
   - **Self-moves**: a row whose actor is the parent owner (the actor session's employee
     is the parent's assignee) is marked `deduped`. The owner made the move and knows.
   - **Dedupe against the session callback**: a row whose actor is a session that reports
     to the resolved target (`withReportingParent(actorSession).parentSessionId ===
     target.id`) is marked `deduped`. That child's own turn-end callback reaches the same
     session, so a `delegate_task` child never wakes the parent twice. A child moved by
     anyone else (the operator, a reviewer, the board walk's dispatcher, a session that
     reports elsewhere) still wakes the parent.
   - **Owner session found**: claim ONE outbox delivery for all remaining rows through
     `claimSessionDelivery` (the durable outbox parent callbacks and heartbeats use):
     `sourceKind: "work-item"`, `sourceId: parentId`,
     `sourceAttempt: "child-settles:<lowest row id>-<highest row id>"`,
     `sourceOutcome: "children-settled"`, `deliveryKind: "todo-child-settled"`. Rows are
     marked `woken` with the delivery id in the same transaction. The message lists each
     child (id, title, `from → to`, who moved it, the move's note clipped to 500 chars) and
     says how to act: `get_work_item` on each, accept or send back a child in `in_review`
     (Part C), unblock or re-plan a `blocked` one, and carry the parent on when nothing is
     left open.
   - **No owner session, parent `executing`**: `redispatchTodo(parentId, ctx, reason)`
     (`gateway/todo-redispatch.ts`) with the same child list as the reason; rows
     `redispatched`. If the re-dispatch is refused because a dispatcher is already running,
     the rows are still `redispatched`: the new session reads the tree.
   - **No owner session, parent `blocked`**: rows `recorded` and one comment on the parent
     listing the children, so whoever resumes it sees them. A blocked parent waits on a
     person, and a sweep never restarts it.
5. **Busy targets.** `todo-child-settled` deliveries fold into the pending tail turn the
   same way `parent-completion` deliveries do (`sessions/completion-batching.ts`), so a
   wake that lands while the owner is busy joins the queued completion turn rather than
   making another.
6. **Stall check.** `hasOpenDelegations` also counts a parent with pending
   `work_item_child_settles` rows, or with a `todo-child-settled` delivery still `pending`
   in the outbox: a wake is on its way, so the parent is not idle. A child in `in_review`
   addressed to the parent (Part C) is not an open delegation: the parent has been woken
   and the next move is its own, so the ordinary 4 h stall clock runs from that wake.

## Part B: Automatic child-watch heartbeat

1. **One per session, gateway-owned.** A heartbeat carries a `purpose`. The gateway arms
   `purpose = 'child-watch'` for the calling session when that session:
   - creates a Todo with `parentId` (`POST /api/work-items`),
   - delegates (`POST /api/delegations`), or
   - spawns a session (`POST /api/sessions` with the caller as parent).

   Interval 3600 s; `expiresAt` = now + 24 h. If the session already holds an armed
   child-watch heartbeat it is not duplicated: its expiry is pushed to now + 24 h. The
   gateway's own heartbeat does not count against `MAX_ARMED_PER_SESSION`. Sessions with
   no session identity (the operator's web surface) arm nothing.
2. **Storage.** A nullable `purpose TEXT` column on `heartbeats`, added by an idempotent
   `ALTER TABLE` guarded on `PRAGMA table_info`, and a partial unique index
   `ON heartbeats(owner_session_id, purpose) WHERE status = 'armed' AND purpose IS NOT NULL`
   so a duplicate cannot be armed even by a race. `list_heartbeats` shows the purpose;
   `stop_heartbeat` stops it like any other (a later trigger arms it again).
3. **Message**, delivered verbatim:
   > Child check (armed by the gateway because you have open child work): run
   > get_work_item_tree on your Todo and read the child sessions you started; act on any
   > child that has settled. If nothing needs you, end your turn.
4. **Open children of a session** `S`: a Todo with status `backlog` or `executing` whose
   parent is `S`'s linked Todo or that `S` created with a `parentId` (`sourceRef`
   `session:<S>:` or `delegate:<S>:`), or a child session of `S` that is in flight
   (`isSessionInFlight`).
5. **Auto-stop.** `releaseChildWatchIfSettled(sessionId)` disarms the session's child-watch
   heartbeat with reason `children-settled` when `S` has no open children. It is called:
   - when a heartbeat with that purpose comes due (the scheduler disarms instead of
     delivering, so no idle wake is ever sent),
   - after a parent-completion callback is accepted for `S`, and
   - after a Part A flush targets `S`.

## Part C: Children report to the parent owner

1. **Review addressee.** `reviewAddressee(item)` is the parent owner when the item has a
   parent, the parent's assignee is an employee in the org, and the parent is not closed;
   otherwise the operator. Computed on read, never stored, so a parent reassigned to the
   operator sends its children's reviews to the operator from then on. The Todo payloads
   (compact, board and full) carry `reviewAddressee: { kind: "operator" } | { kind:
   "employee", employee }`.
2. **The child producer does nothing new.** It moves its Todo to `in_review` with a note
   as today. Part A wakes the parent owner with that note.
3. **Parent-owner lane.** The status route (`gateway/work-item-status-lane.ts`) gains a
   lane: a session whose employee is the child's review addressee may move that child
   - `in_review → done` with a note (posted as a comment, as the closer lane does), and
   - `in_review → executing`, recorded as a review bounce (`bounce: true`, `rounds`
     counts, the policy's max rounds escalates to `blocked` as for the operator).

   The self-review ban holds (`closerHandIn`): an employee that worked the child, started
   it, or handed it to review cannot close it. Cancelling, reopening and cascading stay the
   operator's. The `update_work_item` description names the new case within the tool
   manifest budget.
4. **The operator's desk shows only what is addressed to the operator.** A child in
   `in_review` addressed to an employee gets attention lane `manager` (not `operator`); the
   recovery classifier gives it lane `manager` with a reason naming the addressee; the
   board shows it in the review column with a "for <employee>" chip and leaves it out of
   any operator review count. The root Todo, and any child whose parent the operator owns,
   reach the desk exactly as today.
5. **Board hooks** get `reviewAddressee` in the payload and a matcher field
   `reviewAddressee: operator | employee`, so a hook meant for the operator's desk can
   skip parent-addressed reviews. Existing hooks are unchanged until their config adds the
   field (see the deployment notes).
6. **Brief wording.** The lifecycle lines in `sessions/context.ts` gain: a Todo whose
   parent an employee owns hands its `in_review` to that employee, who accepts it (`done`
   with a note) or sends it back; and the parent owner, when woken about a child in
   review, does exactly that. "Never set done" becomes "never set done, except accepting
   a child of a Todo you own".

## Acceptance

- A child Todo started by the board walk or `dispatch_work_item` (no session parent) wakes
  the parent owner when it settles. Test.
- A dead (error/archived) parent owner session re-dispatches the parent; a stopped
  (`interrupted`/idle) one is resumed by the wake. Tests.
- A `delegate_task` child wakes the parent once, not twice. Two children settling inside
  the window produce one wake. Tests.
- The child-watch heartbeat is armed on child creation, delegation and spawn, not
  duplicated, and disarmed when the last child settles. Tests.
- A child in `in_review` under an employee-owned parent is accepted or bounced by the
  parent owner, stays off the operator's desk, and the stall check agrees. Tests.
- An isolated instance shows a parent with two board-walk children being woken and
  completing.
