---
name: todo-handling
description: Create, assign, update, review, and archive Jinn Todos through the typed work-item tools
---

# Todo Handling Skill

Use this skill for deliberately authored, durable work ownership and status tracking. Todos are the live company ledger. Search before creating a duplicate.

## Find the right Todo

- Use `list_work_items` for recent work or structured filters such as `status`, `source`, `assignee`, `department`, and `needsAttentionFor`.
- Use `list_work_items` with `rootsOnly: true` for an objective-level view, `parentId` for one Todo's direct children, or `rootId` for a whole Todo family.
- Use `search_work_items` when you have text or several filters. It requires at least one real filter.
- Use `get_work_item` before changing a Todo so you understand what it asks for, its assignee, source/provenance, and current status.
- Use `get_work_item_tree` when the work has child Todos; it returns the nested breakdown and roll-up.

The statuses are backlog, executing, in_review, done, blocked, and cancelled. A Todo with an owner that has not started sits in backlog with its assignee set. Assigning a Todo, or moving it on the board, starts nothing: a dispatch does.

## Who may move a Todo where

Agent sessions work inside the open statuses: pick work up or put it down (backlog ↔ executing), hand it to review and take it back (executing ↔ in_review), and stop or resume it (any open status ↔ blocked, with a note saying why). Closing a Todo (`done`), cancelling it, reopening closed work and archiving are the operator's. The gateway refuses them to every agent session, reviewers included.

The one exception is the top-level coordinator session the operator is talking to, which carries no employee identity of its own and was opened from the web console, Talk or a chat connector. In exceptional circumstances it may close a Todo as `done` on the operator's behalf: `update_work_item` with `status: "done"`, `asOperator: true`, and the operator's reason in `note`. The reason is required. The audit event records the operator as the actor and names the calling session, and the reason is posted as a comment on the Todo. `asOperator` does nothing else: cancelling, archiving and reopening stay with the operator, and closing a Todo's open descendants along with it stays on the human surface.

## Shape the hierarchy

One operator outcome should normally map to one root Todo. A checklist does not imply one Todo per item. Keep procedural steps, commands, and release checklists in the root Todo body, comments, or session activity.

Only independently assignable or independently reviewable deliverables become child Todos. Create child Todos with `parentId`:

```json
{
  "title": "Verify release artifacts",
  "parentId": "ACM-42",
  "body": "Check the release artifacts.\n\nDone when: checks pass and evidence is attached."
}
```

If another skill asks for one Todo per checklist step, use engine-local progress tracking unless each step passes this durable-work boundary. This Jinn Todo doctrine governs the company ledger. Keep trees shallow and outcome-shaped; do not turn implementation procedures into ledger clutter.

## Create and assign

Create a Todo only for durable work that needs an owner or review trail:

```json
{
  "title": "Verify release candidate",
  "body": "Run the release checks and attach the evidence.\n\nDone when: typecheck, tests, lint, and build pass with command output.",
  "department": "engineering"
}
```

1. Search for an existing item covering the same outcome.
2. Call `create_work_item` with a concise title and a body that gives enough context to act and says, testably, what done looks like. There is no separate acceptance field: the criteria belong in the body.
3. Call `assign_work_item` next: creation never carries an assignee, so assignment is always its own second call. Verify the employee with `get_employee` or `find_employees` first.
4. Use `delegate_task` instead when the assignee should start immediately; it can use an existing `workItemId` or create and link a new Todo atomically.

Do not invent provenance during creation. Each owning company surface records its own source provenance.

### Auto-start and the Todo you will work yourself

Assigning a Todo, or changing its status, starts nothing. A session starts when the Todo is dispatched (`dispatch_work_item`), or when the board walk starts it from the backlog. To keep the board walk away from a Todo, pass `"autoStart": false` to `create_work_item`, or later to `set_work_item_dispatch`. That flag is the only opt-out; a label does not do it. Set it when you create a Todo you will work from this session, or one that should wait for a hand-over by message. `get_work_item` shows the flag under `dispatchConfig`; `set_work_item_dispatch { autoStart: true }` restores the default.

## Comments are the record

A Todo's comments are its conversation: questions, decisions, handoffs and evidence go there, with `comment_work_item` (pass `parentCommentId` to reply in a thread). The gateway records the session that wrote each comment from your verified identity, and the Todo page links it; never write your session id into the body yourself.

Who a comment wakes:

- **`@employee`** wakes that employee on this Todo, in a comment or a reply. If they already have a session on it, even an idle one from days ago, the comment is delivered there; otherwise one is started, with your comment as its brief. A tagged employee is consulted, not handed the work: the claim stays with whoever holds the Todo.
- **A reply** reaches the session that wrote the comment it answers. Reply to the comment itself (its own `parentCommentId`), not the thread root, or it goes to the root's author. Reply when the thread needs something from you, not to acknowledge: replies between sessions on one Todo are capped.
- **Anything else.** A comment with no mention is recorded only and wakes no one. To get someone's attention, mention them.

One employee has one session per Todo. A delegation or dispatch to an employee who already has a session on the Todo lands in that session, which takes the Todo's claim and reports to whoever delegated it.

There is no separate approval step. When work needs a person's decision, stop it in blocked and comment with what is needed and the options; when it is finished, hand it to the operator in in_review.

## Keep status honest

- Worker finished and ready for review: `update_work_item` to in_review with a note naming artifacts, checks, and remaining risks. The note is required: it is the review handoff, and the gateway posts it on the Todo as a comment.
- Cannot proceed without an external change: move to `blocked` and state the concrete blocker plus what would unblock it.
- A manager/operator decision is required: move to `blocked` and say in the note what is needed, then comment with the options and your recommendation.
- Finished work waits in in_review for the operator, who closes it. No agent marks a Todo `done`.

Example:

```json
{
  "id": "wi_example",
  "status": "in_review",
  "note": "Implemented the requested change; typecheck, tests, lint, and build are green. Evidence is attached to the child session."
}
```

Archiving (`archive_work_item`) and cancelling are the operator's decisions: an agent that finds obsolete clutter says so in a comment instead.

Delegating onto a Todo that already exists asks for standing over it: its owner, that owner's manager, or the org root. The top-level orchestrator session holds that standing over any Todo despite having no employee identity. A session spawned beneath it does not inherit it.

## Review loop

1. A reviewer calls `get_work_item` and inspects the linked execution session, the handoff comment and any separately supplied evidence.
2. The reviewer's findings go back to the producer, as a comment on the Todo or to the session that asked; the reviewer does not move or close the Todo.
3. The producer fixes what was found while the Todo stays in executing, then hands it to in_review with a fresh summary.
4. The operator reads in_review and closes the Todo, or sends it back with a comment.

Report Todo id, title, assignee, status, verification result, and next owner. Do not create a second Todo merely because the first is blocked or under review.
