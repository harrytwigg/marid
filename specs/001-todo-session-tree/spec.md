# Feature Specification: Todo Session Tree

**Feature Branch**: `claude/jin-session-switching-tree-6f15aa`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "if the session's running, I want to be able to switch from this Todo to it, and if any sub-employees are working on it, I want to see that tree as well — e.g. I can see a linked session but I can't click into it; I also want to see if that session asks another employee to review a task, that needs linking too."

## Why This Matters *(fork direction)*

Against the Footprint Ladder in the constitution's Principle II this sits at **rung 4** — the
operator gets a better view of a decision they still make themselves — and it stops there
deliberately. The same principle supplies the reason it is still worth building: *"Autonomy
raises the bar on being able to reconstruct what happened and why... A decision the operator
cannot audit after the fact is not delegation, it is a black box."*

An org that starts its own work produces a tree of work per Todo: a dispatcher, the employees
it delegates to, the reviewer it hands off to. Today that tree exists in the data and is
invisible in the product — the operator can see that *something* is running and cannot reach
it, cannot see who else was pulled in, and cannot tell a review hand-off from a sub-task. Every
higher rung this fork wants to climb (work that starts without a human, a system that defers
and promotes its own work) makes that tree deeper and the blindness worse. The audit surface is
a precondition for the autonomy, not a consolation prize for lacking it.

## Current-State Evidence *(Principle VII)*

Verified against the worktree at the time of writing. References rot — re-verify before the
plan is handed over.

| `path:line` | What it is | Bearing on this feature |
| --- | --- | --- |
| `packages/web/src/routes/todos/task-page/props-rail.tsx:135` | `createdByLabel` — `createdBy` rendered through `displayNameOf`, which falls back to the raw key | A Todo minted by a session shows the literal text `session:15279347-…`. Inert: no link, no name, no state. This is the reported dead end. |
| `packages/web/src/routes/todos/task-page/props-rail.tsx:196` | `rail-dispatch-session` button | The *only* clickable session affordance on a Todo today. |
| `packages/web/src/routes/todos/task-page/task-page.tsx:148` | `dispatcherSession` = the linked session whose `employee === "todo-dispatcher"` **and** whose status is live | Narrows the whole rail to one session. A Todo worked by a non-dispatcher employee, or by a dispatcher that has gone idle, offers nothing to click. |
| `packages/web/src/routes/todos/task-page/task-page.tsx:477` | `navigate('/?session=<id>')` | The existing switch-to-session navigation; the tree reuses it rather than inventing a route. |
| `packages/web/src/routes/todos/task-page/whisper.tsx:87` | `if (actor.startsWith("session:")) return "A session"` | Audit lines name the actor as an anonymous "A session" — the identity is in hand and is thrown away. |
| `packages/web/src/routes/todos/task-page/activity.tsx:39` | comment author `session:` prefix branch | Same loss on the comment thread. |
| `packages/jinn/src/gateway/api.ts:2828` | `GET /api/work-items/:id/sessions` (`listSessionsByWorkItem`) | The Todo→sessions edge already has a read route; the Todo page already calls it. |
| `packages/jinn/src/gateway/api.ts:2216` | `GET /api/sessions/:id/children` (`listChildSessions`) | The session→children edge already has a read route. |
| `packages/web/src/lib/api.ts:796` | `getSessionChildren` | Already defined in the web client and **called from nowhere in `packages/web/src`** — the children edge is plumbed to the browser and unused. |
| `packages/jinn/src/gateway/api.ts:1128` | `serializeSession` returns `{ ...session, … }` | `parentSessionId`, `workItemId`, `workItemRole` and `employee` already reach the browser; `LinkedSessionWire` (`packages/web/src/lib/api.ts:677`) simply does not name them, absorbing them into its index signature. |
| `packages/jinn/src/sessions/registry.ts:145` | `parentSessionId` mapped off `parent_session_id` | The delegation edge, per session. |
| `packages/jinn/src/sessions/registry.ts:136` | `workItemRole` mapped off `work_item_role` | **A review hand-off is already a distinct link role in the database.** |
| `packages/jinn/src/work-items/link-role.ts:51` | `resolveDelegationLinkRole` — explicit intent wins, else `in_review` implies `review` | Where that role is decided. Requirement 3 is a display problem, not a modelling one. |
| `packages/jinn/src/sessions/migrate.ts:87` | `idx_sessions_parent` on `parent_session_id` | Walking the tree by parent is an indexed read. |
| `packages/jinn/src/sessions/delegated-activity.ts:13` | `buildDelegatedActivityIndex` — walks the ancestor chain, `visited` set, "graph cycles are contained" | The existing, tested cycle-containment precedent. The tree walk follows its rule rather than inventing a second one. |
| `packages/jinn/src/mcp/delegation-tools.ts:95` | `delegate_task` → `POST /api/delegations` (`packages/jinn/src/gateway/api.ts:3625`) | One call mints/resolves a Todo, spawns the child session, links the two. This is what puts a *second* Todo under the first one's tree. |
| `packages/jinn/src/mcp/delegation-tools.ts:26` | "`jinn_request_review` is deliberately ABSENT" | Review is delegation with a reviewer-shaped brief, so it arrives on the same edges — nothing new to traverse. |
| `packages/web/src/components/peek/peek-stack.tsx` | existing stacked-peek surface | Considered and **rejected** for this feature: the ask is to *switch* to the session, and the rail's existing affordance already navigates. |

The join that does not exist: nothing in the product composes the Todo→sessions edge with the
session→children edge. Both halves are built, indexed, routed and typed; no caller walks from
one to the other.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Click into the session that is working this Todo (Priority: P1)

An operator looking at a Todo that is being worked can reach the session doing the work in one
click, whoever the employee is and whatever state the session is in — not only when a live
`todo-dispatcher` happens to be the one holding it.

**Why this priority**: It is the reported dead end, and it is the smallest thing that is
independently useful. Shipped alone, a Todo stops being a terminus.

**Independent Test**: Open a Todo worked by a non-dispatcher employee, click the session
reference, land in that session's chat. No tree required.

**Acceptance Scenarios**:

1. **Given** a Todo with one linked session that is running, **When** the operator activates the session reference, **Then** the application switches to that session's conversation.
2. **Given** a Todo whose `createdBy` is a session, **When** the operator views the Details rail, **Then** that reference shows the session's employee and state and is activatable — not the raw `session:<uuid>` string.
3. **Given** a Todo with a linked session that has finished, **When** the operator views the Todo, **Then** the session is still reachable (a finished attempt is the thing an audit most needs to open).
4. **Given** a Todo with no linked session, **When** the operator views the Todo, **Then** the existing Dispatch affordance is unchanged and no empty tree is drawn.

---

### User Story 2 - See the whole tree of work under this Todo (Priority: P2)

The operator sees every session working the Todo and, beneath each, every session it delegated
to, recursively — each node naming its employee, its live/idle/finished state, and the Todo it
tracks where it minted one. Every node is activatable through to that session, and to its Todo
where one exists.

**Why this priority**: This is the audit surface the fork's direction requires, but it is
worthless without US1's navigation, so it follows it.

**Independent Test**: Delegate from a Todo's session to a second employee, then from that
session to a third; the Todo shows a three-level tree with correct employees and states, and
each node opens.

**Acceptance Scenarios**:

1. **Given** a Todo whose session has delegated to two employees, **When** the operator views the Todo, **Then** both child sessions appear beneath their parent with employee, state, and — where the delegation minted one — the Todo they track.
2. **Given** a grandchild session three levels deep, **When** the operator views the Todo, **Then** it appears under its own parent, not flattened to the root.
3. **Given** a node whose delegation minted a Todo, **When** the operator activates that Todo reference, **Then** the application opens that Todo's page, from which its own tree is visible.
4. **Given** a child session that finishes while the Todo page is open, **When** its state changes, **Then** the displayed state follows without the operator reloading the page.
5. **Given** a session tree containing a cycle in the parent links, **When** the tree is built, **Then** it terminates and no session appears as its own descendant.

---

### User Story 3 - Tell a review hand-off apart from a sub-task (Priority: P3)

When a session hands a task to another employee to review, the reviewer's session and the Todo
it is reviewing appear in the tree, marked as a review rather than as more sub-work.

**Why this priority**: The edge is already carried in the data, so this is a labelling and
completeness slice on top of US2 — but without it the tree lies about *why* someone is
involved, which is exactly the "who decided what" the audit is for.

**Independent Test**: Delegate onto a Todo that is `in_review`; the resulting node appears in
the tree labelled as a review and opens like any other node.

**Acceptance Scenarios**:

1. **Given** a session linked to a Todo with the review role, **When** the tree is displayed, **Then** that node is distinguishable from an execution attempt.
2. **Given** a reviewer session that itself delegates, **When** the operator views the tree, **Then** the reviewer's own children appear beneath it.
3. **Given** a review round that has finished, **When** the operator views the Todo, **Then** the reviewer node remains in the tree as a record.

---

### Edge Cases

- **Cycles in the parent chain** — the walk terminates and no session is its own descendant, matching the containment `buildDelegatedActivityIndex` already applies.
- **Very deep or very wide trees** — a tree past the display bound is truncated with an explicit, honest marker of what is not shown; it never silently drops nodes and never hangs the page.
- **Archived sessions** — still shown, visibly archived, still reachable. An archived session is the most likely subject of an audit.
- **Deleted sessions** — *(revised during implementation, see FR-010)* a session linked to a Todo **cannot be hard-deleted**, so no node in the tree can refer to a missing row. A session the Todo names directly but that no longer exists is still reported, as unresolvable text rather than a broken link.
- **A child session with no minted Todo** — renders as a session-only node; it is not given a fake Todo reference.
- **A Todo reached from a node, whose own tree overlaps the first** — revisiting an already-shown node does not loop.
- **The tree grows while the operator is looking at it** — new nodes appear in place; the operator's current expansion state is not reset underneath them.
- **A session whose employee was deleted from the org** — the node still names the recorded employee key rather than rendering nameless.
- **Workflow phase sessions** linked to the Todo — appear as nodes and are not mistaken for execution attempts (the same distinction `isExecutionAttempt` already draws).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every session reference shown on a Todo — the Details rail's creator reference, the linked-session affordances, audit and comment lines whose actor is a session — MUST resolve to a human-readable identity (employee and state) and MUST be activatable to switch to that session.
- **FR-002**: Activation MUST switch the operator to that session's conversation using the application's existing session navigation; the Todo remains reachable by going back.
- **FR-003**: The Todo MUST present the tree of sessions rooted at it: every session linked to the Todo, and beneath each, every session spawned from it by delegation, recursively.
- **FR-004**: Each node MUST show the employee responsible, the session's current state (running / idle / finished / archived), and the Todo it tracks where one exists.
- **FR-005**: Each node MUST be activatable to that session; where the node tracks a Todo other than the one being viewed, that Todo MUST be separately activatable.
- **FR-006**: A node whose link to a Todo is a **review** MUST be visually distinguished from one that is an execution attempt, and MUST appear in the tree on the same terms as any other node.
- **FR-007**: Tree construction MUST terminate on cyclic parent links, and no session may appear as its own descendant.
- **FR-008**: Tree construction MUST be bounded in depth and node count; when the bound truncates the tree, the operator MUST be told what was withheld rather than shown a silently short tree.
- **FR-009**: Node states MUST follow live changes — a session that starts, finishes, or is delegated to while the Todo is open updates in place without a reload.
- **FR-010**: Sessions that are archived MUST remain in the tree, visibly marked. **Revised during implementation:** the original clause required a tombstone node for a deleted session. That case is unreachable — deletion refuses any session linked to a work item (`deleteSession`/`deleteSessions` and the bulk route all carry `work_item_id IS NULL`), so every session in the tree is a row that still exists. The only deletable session is an untracked spawn, and when one goes its `parentSessionId` edge goes with it, leaving nothing that ties its children to this Todo — a placeholder root would attach unrelated work rather than preserve provenance. The requirement now binds where it is detectable: a session id the Todo names **directly** (its creator, a comment author, an audit actor) that no longer resolves MUST be shown as unresolvable rather than silently omitted or rendered as a dead link.
- **FR-011**: The tree MUST NOT alter any Todo or session state. It is a read surface; the existing Dispatch affordance remains the only action on the rail.
- **FR-012**: A Todo with no linked sessions MUST render exactly as it does today, with no empty tree region.

### Key Entities

- **Todo (work item)**: the unit of accountability. Has zero or more linked sessions; may itself have been minted by a delegation from another Todo's session.
- **Session**: one employee's thread of work. Carries the employee, a lifecycle state, an optional parent session (the delegation edge), and an optional linked Todo with a role.
- **Link role**: why a session is attached to a Todo — *execute* (it is doing the work) or *review* (it is checking someone else's). Already recorded; not currently shown.
- **Tree node**: a session in its position beneath the Todo — its employee, its state, its link role, the Todo it tracks if any, and its children.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a Todo that is being worked, an operator reaches the session doing the work in **one activation**, for **100%** of Todos that have at least one linked session — regardless of which employee holds it or whether that session is still live.
- **SC-002**: **Zero** raw `session:<id>` strings remain visible to the operator anywhere on the Todo page; every one is replaced by a named, activatable reference.
- **SC-003**: For a Todo whose work fanned out across N employees, an operator can name all N and open any one of them **without leaving the Todo page first** — where today they can name at most one.
- **SC-004**: An operator can tell, for every participant in a Todo's tree, whether that participant was doing the work or reviewing it — in **under 5 seconds**, without opening any session.
- **SC-005**: A Todo page with a tree of at least 50 nodes remains interactive: it renders and responds to expansion without the operator perceiving a stall.
- **SC-006**: A delegation made while the Todo page is open becomes visible in the tree **without a manual reload**.
- **SC-007**: Reconstructing "who touched this Todo and why" after the fact requires **no** database or log access — the Todo page is sufficient.

## Assumptions

- **Placement**: the tree lives on the Todo detail page, near the existing linked-session affordance in the properties rail, rather than in a new top-level view. The user's ask is framed from the Todo ("switch *from this Todo*"); a separate view would reintroduce the navigation the feature exists to remove.
- **Navigation is a switch, not a preview**: activating a node navigates to the session, matching the behaviour the Dispatcher chip already has. The existing stacked-peek surface is out of scope for this feature.
- **The tree crosses Todo boundaries via sessions, not via Todos**: traversal follows session→child-session links. A Todo minted by a delegation is *named* on its node and is reachable by activating it, but its own independently-dispatched sessions are that Todo's tree, not this one's. This keeps the walk finite and the meaning of "this Todo's tree" honest: it is the work this Todo caused.
- **Review needs no new model**: `workItemRole` already distinguishes review from execution, and `delegate_task` already carries review hand-offs. No new delegation kind, tool, or column is assumed.
- **Bounds are display bounds**: a depth and node-count ceiling is chosen to keep the page responsive, not to enforce policy. Trees exceeding it are truncated visibly.
- **Live updates reuse the existing signal path**: the same mechanism that already updates session state elsewhere in the product drives node states; no new push channel is assumed.
- **Scope excludes**: cost/spend roll-up per node, editing or stopping sessions from the tree, an org-wide tree view spanning all Todos, and any change to how delegation or review is *performed*. This feature only makes what already happens visible.

## Dependencies

- The Todo→sessions and session→children read paths (`GET /api/work-items/:id/sessions`, `GET /api/sessions/:id/children`) and the fields already serialized onto a session (`parentSessionId`, `workItemId`, `workItemRole`, `employee`, `status`).
- The existing session navigation target used by the Dispatcher affordance.
- The existing live-session signalling used elsewhere in the chat surface.
