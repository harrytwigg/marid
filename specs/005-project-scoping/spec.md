# Feature Specification: Projects and Project-Scoped Employees

**Feature Branch**: `feat/project-scoping-spec`

**Created**: 2026-10-05

**Status**: The operator answered Q1–Q11 on 2026-10-05. The decisions are recorded below and
folded into the text. Ready for implementation per plan.md and tasks.md. Employees on another
Claude account use the existing per-employee profile setting (see "Employees on another
Claude account").

**Input**: Marid issue #90 (upstream proposal hristo2612/jinn#81). The operator wants projects
as a first-class scope:

- Todos are raised inside a project.
- An employee can be limited to certain projects.
- A limited employee cannot reach the company setup through Jinn.
- Skills can be restricted per project.

**The motivating case** is a friend who lets the operator use their Claude account for the
friend's side project, and only for that project. The operator:

1. makes a project for the side project;
2. makes employees that run on the friend's Claude account and are scoped to that project.

Existing employees still reach everything, the project included, and can delegate into it.
The restriction runs one way only. That is configurable: a project can also be closed to
everyone except its own members.

## Operator decisions (2026-10-05)

| Q | Decision | Effect on this spec |
| --- | --- | --- |
| Q1 | **A. Enforce through MCP and the gateway, plus the state files. No sandbox.** An agent that deliberately reads around the tools is not this feature's problem. It is discouraged in the project's instructions. Proper sandboxing is future work | Containment (old US3, FR-021 to FR-025a, Phase 0 and Phase 4) is withdrawn and moved to "Deferred to future sandbox work". research.md keeps the findings for that work |
| Q2 | **a.** A scoped employee delegates only within its project. Unscoped employees, the COO included, reach everything | FR-016 unchanged. FR-007's `all` scope is the default for every existing employee |
| Q3 | "Whatever is the best architecture", plus "configuration via YAML is good" and "show it on the org tree" | **Project definitions live in YAML** under `$JINN_HOME/projects/`, mirroring `org/`. Todo membership lives in the registry, keyed by the project's stable id, the same way Todos reference employees by name (FR-001, data-model.md) |
| Q4 | No MCP parameter | FR-036 unchanged |
| Q5 | Project instructions only | FR-029 unchanged |
| Q6 | **b.** Existing employees keep reading everything as today. The new restrictions apply only to scoped sessions | Phase S is withdrawn. `read_knowledge` and the attachment paths change only for scoped callers (FR-018, FR-028) |
| Q7 | Not answered. It falls away with Q1 = A, because there is no contained environment for secrets to feed | FR-030 to FR-032 are deferred with containment |
| Q8 | **a**, plus: employees on a project must not be able to work on anything else | That is the base rule already: a scoped employee holds only its projects' Todos. `dedicated` (FR-015) is how a project is closed to everyone else |
| Q9 | Not fussed | Today's behaviour is kept, with no engine flag changes |
| Q10 | a (a live reply) | FR-013 unchanged |
| Q11 | Moot under Q1 = A | Withdrawn |

**New in the operator's answer**:

- employees bound to a different Claude account. The operator cancelled the separate spec for this on 2026-10-06, because the existing per-employee profile setting already covers it (see "Employees on another Claude account");
- project membership shown on the org tree (FR-041);
- configuration in YAML, with UI editing where possible (FR-001, FR-042).

## Why This Matters *(constitution Principle II)*

**Rung 4.** The operator gets a bounded remit for a set of employees, and a choice of which
account their work runs on. No decision moves to the system.

It belongs in this fork because it lets outside capacity, such as a friend's account, run a
project's backlog unattended, without the system mixing that work into the company's.

There is no spend ceiling of its own. The per-employee monthly cap (`config.budgets.employees`,
`packages/jinn/src/sessions/turn/preflight.ts:63`) applies as today. A friend's account is
also bounded by that account's own plan limits.

## Scope of the boundary *(read this first)*

Scoping is enforced **in the gateway and in the jinn MCP tools**. The gateway refuses a scoped
session's out-of-scope requests whichever tool makes them.

It is **not** an OS boundary. Every engine runs as the operator's macOS user and has a shell.
A scoped employee that deliberately uses its shell can still read `$JINN_HOME`, other repos
and credential directories. It can see other processes' environments, including the gateway
token, and call the gateway with that token. research.md ("Containment: what Phase 0 must
establish") records the full list for the future sandbox work.

This feature responds in three ways:

- **It discourages shell access.** The project's instructions file says not to (FR-029).
- **It removes the easy paths.** The company `CLAUDE.md`, the company skills directory and the
  company state files are not loaded (FR-020, FR-027, FR-028), and the jinn tools refuse.
- **It keeps the docs honest.** Scoped employees are described as "kept in scope by the
  gateway", not "cannot reach".

**Between Phase 2 and Phase 3.** Scoped employees already exist after Phase 2, but they still
run with cwd `~/.jinn`. Until Phase 3 they therefore load the company `CLAUDE.md` and every
skill. This is acceptable as an interim under Q1 = A, because they run on the operator's own
account. It is why an employee should move to another account only once Phase 3 is in place.

## What the tree does today *(facts the spec depends on)*

research.md has the full audit, with `path:line` citations.

1. **Nothing in the data model resembles a project.** Sprints and labels live in join tables,
   because the boot verifier refuses any column added to `work_items`
   (`packages/jinn/src/work-items/sprints-schema.ts:5`).
2. **Employees are YAML, referenced by name from the registry.** `work_items.assignee` is a
   name, not a foreign key. A watcher reloads the roster from `org/`
   (`packages/jinn/src/gateway/watcher.ts:130`). Projects follow the same pattern.
3. **The only per-employee allow-list is `mcp`** (`packages/jinn/src/shared/types.ts:529`).
   - Every skill is linked into one shared `~/.jinn/.claude/skills`
     (`packages/jinn/src/gateway/watcher.ts:38`).
   - Local engines always run with cwd `$JINN_HOME`
     (`packages/jinn/src/sessions/turn/engine-run.ts:46`).
   - So every session loads the company `CLAUDE.md` and every skill.
4. **The Claude account is global for local sessions.**
   - `resolveClaudeConfigDir` reads the gateway's own `CLAUDE_CONFIG_DIR` at call time
     (`packages/jinn/src/shared/home.ts:34`).
   - Only remote employees can name their own profile, with `remoteClaudeConfigDir`
     (`packages/jinn/src/shared/remote-target.ts:232`).

## User Scenarios & Testing *(mandatory)*

### User Story 1: The operator groups Todos into a project (Priority: P1)

The operator creates a project, either by writing `projects/side-project.yaml` or on the
Projects page, and raises Todos inside it. On the board they switch to the project and see
only its Todos, each with a project badge. Existing Todos carry no badge and are unchanged.

**Independent Test**: create a project, two Todos in it and one outside it. The list API, the
board and the switcher return exactly the two project Todos. With no filter, all three are
returned.

**Acceptance Scenarios**:

1. **Given** no projects exist, **When** the operator opens the board, **Then** it behaves
   exactly as today.
2. **Given** project P, **When** the operator creates a Todo in P, **Then** the card, list row
   and detail rail show P, and its sub-tasks inherit P (FR-004).
3. **Given** a Todo in P, **When** its project is set to none, **Then** it becomes
   company-level, and a `project_changed` event records the old and new values.
4. **Given** P is archived (`archived: true`), **When** anyone creates a Todo in P or moves one
   into it, **Then** the request is refused. P's Todos stay readable.
5. **Given** `projects/side-project.yaml` is renamed or moved, **Then** its Todos keep their
   membership, because the stable `id` in the file did not change.

---

### User Story 2: A scoped employee works only inside its project (Priority: P1)

The operator scopes a new employee, `side-dev`, to "Side project". From a `side-dev` session,
the jinn tools return only P's Todos, P-bound sessions, and employees scoped to P.

- Company Todos read as *not found*.
- Cron, cost, config and the org setup are refused.
- A company Todo cannot be assigned to `side-dev`.

**Independent Test**: the enforcement tests for FR-010 to FR-019. Each test drives the real
API handler as a capability-bound session of a scoped employee. The seeded registry holds
company Todos, Todos in two projects, and sessions of both scoped and unscoped employees.
Every row of the scoped-caller table in plan.md has an allow case and a refuse case.

**Acceptance Scenarios**:

1. **Given** `side-dev` is scoped to P, **When** it lists Todos, **Then** it gets only P's.
2. **Given** company Todo `ACM-5`, **When** `side-dev` reads, comments on, attaches to,
   assigns, links or dispatches it, **Then** it gets a 404 identical to an unknown id.
3. **Given** `side-dev` creates a Todo, **Then** it lands in P.
4. **Given** the COO works a P Todo, **When** `side-dev` lists or reads sessions, **Then** the
   COO's session is not among them (FR-009).
5. **Given** the COO spawned `side-dev`, **When** `side-dev` replies, **Then** the reply reaches
   the COO (FR-013). Replies to any other non-P session are refused.
6. **Given** `side-dev` delegates to `senior-developer` (unscoped), **Then** the request is
   refused. A delegation to `side-qa` (scoped to P) succeeds.
7. **Given** anyone assigns a company Todo or another project's Todo to `side-dev`, **Then** the
   assignment is refused (FR-015).

---

### User Story 3: Existing employees reach into the project, unless it is closed (Priority: P1)

The COO and the existing developers are unscoped. They see P's Todos on the board, delegate a
P Todo to `side-dev`, or work one themselves.

When the operator sets `dedicated: true` on P, only P's members can hold P's Todos. The
existing employees can still read and comment, but can no longer be assigned P's work.

**Independent Test**:

1. With P not dedicated, assigning a P Todo to `senior-developer` succeeds.
2. Setting `dedicated: true` while `senior-developer` holds that Todo is refused, and the
   refusal names them.
3. After the Todo is reassigned, setting `dedicated` succeeds. Assigning a P Todo to
   `senior-developer` is then refused.
4. Unscoped behaviour on company Todos is unchanged throughout.

---

### User Story 4: (not built here) Project employees on a different Claude account

The existing per-employee profile setting delivers this story, so no PR in this feature does.
See "Employees on another Claude account" below.

---

### User Story 5: A project limits skills, Notes, instructions and state (Priority: P2)

The operator gives P a skill allow-list, an instructions file, and a project Notes folder that
includes the project's own state file.

- A scoped session's engine sees only the allowed skills and the project instructions, never
  the company `CLAUDE.md`.
- The jinn knowledge tools reach only the project's Notes and state, plus anything P
  explicitly shares. They never reach the company `state.md` or the employee state files.

**Independent Test**: from a scoped session:

- `read_knowledge` of `knowledge/state.md` returns 404;
- a `search_knowledge` term present in both a company Note and a project Note returns only
  the project Note;
- the session's cwd holds exactly the allowed skills and the project `CLAUDE.md`.

---

### User Story 6: The operator sees and edits scope in the UI (Priority: P2)

- **Org tree:** shows each employee's projects, and a project filter narrows the tree to one
  project's members.
- **Projects page:** lists projects, with their members, working directories, skills, shared
  Notes and the `dedicated` flag. They can be edited where FR-042 allows.
- **Employee edit panel:** sets project scope and the Claude config dir.
- **Project switcher:** narrows the board and the sidebar.
- **New chat:** starting a chat with a scoped employee that has more than one project asks
  which project.

**Independent Test**: Playwright against a throwaway sandbox gateway, following the
`scripts/verify-chat-grid-drop.sh` pattern. Every new or changed element is captured in light
and dark, with screenshots on the PR (FR-040).

---

### Edge Cases

- **A Todo leaves P while a scoped session is working it.** The session's next call on that
  Todo returns 404. The turn finishes, and an `escalated` event is written on the Todo.
- **Scope narrowed while sessions are live.** Scope is read from the live roster on each
  request. A session bound to a project its employee has lost is refused everywhere except
  its own transcript, and `refuseTurn` starts no new turn in it.
- **Scope emptied.** This is distinct from unrestricted (FR-007). An employee whose `projects`
  key names no known project reaches nothing. Removing a scope never widens it.
- **Sub-tasks** inherit the root's project and cannot set their own. There is no re-parenting
  (`packages/jinn/src/gateway/api.ts:2192`).
- **Linking.** A scoped caller can link only P Todos, and sees any relation to a non-P Todo as
  a hidden count. Unscoped callers can link anything.
- **Project YAML removed, or its id changed.** Todos that reference an unknown project id are
  treated as an archived project:
  - unscoped readers see them with an "unknown project" badge;
  - scoped callers never see them;
  - nothing new is created in them;
  - the gateway log reports the dangling id at scan time.
- **Two project files with the same id.** The scan refuses both, logs the conflict and keeps
  the last good set, as `scanOrg` does for employees
  (`packages/jinn/src/gateway/org-registry.ts:47`).
- **Names.** Unique ignoring case. `none` and `all` are reserved, because the filter grammar
  uses them.
- **Numbering.** Unchanged. The project is a separate dimension from the department.
- **System employees** (Dispatcher, board walk, Shaper) stay unscoped. They follow FR-015 and
  never route a Todo to an employee who may not hold it.
- **The remote MCP connector** stays unscoped.
- **Connector-originated sessions** (Telegram) for a scoped employee are refused in v1.
- **Cron.** Validation refuses a cron job that targets a scoped employee.
- **Project id reused.** A project file is deleted, and a file with the same `id` but a
  different `name` later appears. The scan reports it in the gateway log and on the Projects
  page: "id previously used by <old name>". It does not refuse the file, because the operator
  may be restoring a backup (FR-001).

## Requirements *(mandatory)*

### Functional Requirements

**Projects and membership**

- **FR-001**: Each project MUST be defined by one YAML file under `$JINN_HOME/projects/`, for
  example `projects/side-project.yaml`. The file carries:
  - a required stable `id`: `prj_` followed by 12 hex characters. It never changes;
  - `name`, unique ignoring case;
  - `description`;
  - `archived`;
  - `dedicated`;
  - `workdirs`, `skills`, `sharedNotes` and `instructions` (see data-model.md).

  The gateway scans and watches the directory as it does `org/`. The Projects page creates new
  files with a generated id. The file name is presentation only.

  How the scan treats problems:

  - **Identity problems.** A missing or malformed `id`, a duplicate or reserved `name`, or YAML
    that does not parse refuses the file. If that **file path** last loaded a project, the scan
    keeps that project's last good definition and logs the refusal. A broken file has no
    readable id, so the match is by path. A typo therefore never turns a live project into
    an unknown one.
  - **Duplicate ids.** The definition already loaded for that id is kept, and the newcomer is
    refused. On a fresh boot, files are loaded in lexical order of file name, so "first" is
    deterministic.
  - **Content problems.** A `skills` entry that no longer exists, a `workdirs` entry that fails
    FR-033, or a bad `sharedNotes` path drops only that entry, with a logged warning. The
    project itself stays loaded.
  - **Missing directory.** If `projects/` does not exist, there are no projects, and nothing is
    logged.
- **FR-002**: A top-level Todo MUST belong to zero or one project, recorded in the registry by
  project id. No project means company-level. **No existing Todo is migrated.**
- **FR-003**: The project MUST be settable when a Todo is created, and changeable afterwards,
  through REST and the web UI. Every change writes a `project_changed` event.
- **FR-004**: A sub-task's project MUST be its root's.
- **FR-005**: The Todo list API MUST accept an optional `project=<id>|none`. Payloads gain
  `project: {id, name, archived} | null`, which is additive and nullable.
- **FR-006**: An archived or unknown project MUST refuse new members. It stays readable.

**Employee scope and session binding**

- **FR-007**: Employee scope MUST be explicit in the employee's YAML:
  - no `projects` key means **all**. This is today's behaviour and the default for every
    existing employee, the COO included;
  - a present key means **scoped to the known ids**. This holds when the key is an empty
    list, a bare `projects:`, or a list of only unknown ids.

  The wire form is `projectScope: "all" | string[]`. `PATCH /api/org/employees/:name`
  (operator-only) refuses an empty list. Only an explicit `"all"` makes an employee
  unrestricted.
- **FR-008**: A session of a scoped employee MUST be bound to one project when it is created:
  - with a linked Todo, the binding is the Todo's project, which must be in the employee's
    scope. If it is not, the spawn is refused.
  - a conflicting explicit `project` is refused.
  - with no linked Todo, the binding is the explicit `project` if it is in scope, otherwise
    the employee's only project. Anything else is refused.

  The binding is stored on the session and never changes.
- **FR-009**: Only sessions of scoped employees carry a binding. An unscoped session's badge
  is derived at read time from its linked Todo. Scoped filters match only bindings, so an
  unscoped session is never visible to, or reachable from, a scoped one.

**Server-side enforcement** (applies to every request from a capability-bound session of a
scoped employee; P is that session's binding)

- **FR-010**: **Default deny.** Every gateway route not on the scoped-caller table in plan.md
  MUST be refused at the identified-caller gate (`packages/jinn/src/gateway/api.ts:1181`).
  WebSocket upgrades sit outside that gate, and not all of them are operator-only today
  (`packages/jinn/src/gateway/server.ts:1035`). The upgrade guard MUST refuse scoped callers
  on every upgrade path.
- **FR-011**: **Todos.**
  - Lists and searches are limited to P.
  - Per-Todo routes answer 404 for a Todo outside P, identical to the unknown-id response.
  - Creates land in P.
  - A move out of P is refused.
- **FR-012**: **Sessions.** Reads, searches, message context, `send_to_session` and
  `stop_session` are limited to P-bound sessions, except as FR-013 allows.
- **FR-013**: **Replying to a requester.** A scoped session MAY send to its own
  `parent_session_id` (`packages/jinn/src/gateway/spawn-session.ts:188`) with a live
  `send_to_session` (Q10-a). This grants no read access, and no other session can be reached
  this way.
- **FR-014**: **Org.**
  - Org reads return only employees scoped to P, and the prompt roster matches.
  - Departments are not exposed.
  - Applying an existing label is allowed.
  - Label, sprint and department administration are refused.
- **FR-015**: **Who may hold a Todo.** `mayHoldTodo(employee, todoProject)` applies these
  rules:
  - A **scoped** employee holds only Todos in its own projects.
  - An **unscoped** employee holds company Todos, and Todos in any project that is not
    `dedicated`.
  - A **`dedicated`** project's Todos are held only by its members.
  - `@operator` holds anything (`packages/jinn/src/gateway/todo-assignee.ts:21`).

  **Fallbacks**, so FR-035 holds:
  - with no scope resolver injected, everything passes except assignment into a `dedicated`
    project;
  - a name that is not on the roster counts as unscoped;
  - an **unknown project id** (no YAML, or refused) counts as `dedicated`, so it fails closed
    for holders. A broken file never opens a project to everyone.

  **Where it is enforced**: in the work-items layer, at every SQL writer of `assignee`:
  - the `createWorkItem` insert (`packages/jinn/src/work-items/store.ts:356`);
  - the two dynamic update paths in `store.ts`, which are followed by `releaseOnOwnerChange` at
    `packages/jinn/src/work-items/store.ts:797` and `packages/jinn/src/work-items/store.ts:850`;
  - **`assignWorkItem`'s own `UPDATE`** (`packages/jinn/src/work-items/assignment.ts:98`). It
    does not go through `releaseOnOwnerChange`. It serves `POST /:id/assign`, delegation onto
    an existing Todo (`packages/jinn/src/gateway/api.ts:3501`) and the talk adapters.

  The list comes from `git grep` over the SQL, not from a code comment, and T045 re-runs that
  enumeration.
  That covers:
  - `assignWorkItem`, PATCH and the talk adapters;
  - delegation's create-already-assigned path (`packages/jinn/src/gateway/api.ts:3450`);
  - plugin creates (`packages/jinn/src/plugins/host/todos.ts:31`);
  - cron creates (`packages/jinn/src/cron/runner.ts:101`).

  These paths are checked at their own entry instead: spawn with a linked Todo, Dispatcher
  routing, and the board-walk projection (which skips the Todo).

  **Stranding transitions are refused, and the refusal names the holders**: a change of
  project, setting `dedicated`, or a PATCH that narrows a scope. Violations made by
  hand-editing YAML are reported by the scan instead, and FR-008 refuses new sessions on the
  affected Todos.
- **FR-016**: **Spawning from a scoped caller.** `spawn_session`, `delegate_task` and
  `dispatch_work_item` may target only employees scoped to P. The child is bound to P.
- **FR-017**: **Company control plane.** Refused: config, cron, cost, connectors, global
  search, the skills API, and Notes and state outside the project.
- **FR-018**: **Local file reads on a scoped session's behalf.** `publish_attachment`,
  path-based `attach_to_work_item` and the JSON `{path}` attachment route accept only
  realpaths inside P's working directories or P's stage dir. `list_files` and `read_file` are
  refused. Unscoped callers are unchanged (Q6-b).
- **FR-019**: **Tool profile.** A scoped session's MCP manifest omits every tool whose routes
  are all refused. Unscoped manifests are unchanged.

**Scoped context** (what a scoped session's engine loads)

- **FR-020**: A scoped session MUST run with cwd set to a generated stage dir outside
  `$JINN_HOME`: `<parent of home>/.jinn-projects/<project id>/`. This is the only way to stop
  Claude Code loading the company `CLAUDE.md` (it reads from the cwd and its ancestors) and the
  company skills directory.
- **FR-026**: In v1 a scoped employee MUST use the `claude` engine, because the stage dir uses
  Claude's layout (`CLAUDE.md`, `.claude/skills/`). Validation refuses any other engine and
  says why.
- **FR-027**: A project MAY carry a skill allow-list. A scoped session is offered only the
  allow-listed skills, through:
  - copies in the stage dir;
  - the prompt;
  - `dispatchConfig.skills` validation.

  An empty list means no skills.
- **FR-028**: Project Notes live under `knowledge/projects/<project id>/`, and that includes
  the project's state file, `knowledge/projects/<id>/state.md`.
  - **Seeding the state file.** The Projects page creates the file when it creates a project.
    For a hand-written project YAML, the file is created on the first note write. The format
    is the same as the company `state.md`: a title, then sections of keyed bullets
    (`- key: value`). That way the note tools and a future `mem` that respects
    `JINN_PROJECT_ID` (F1) agree on it.
  - **Rooting.** For a scoped caller, `search_knowledge`, `read_knowledge` and the note tools
    are rooted there, plus P's `sharedNotes`.
  - **Note tools always on for scoped sessions.** The scoped profile carries the note tools,
    and the note routes serve scoped callers, even when `gateway.notesEnabled` is off (it is
    off on this instance). This is safe because they are rooted at the project folder, and it
    is how a scoped session reads and writes its own state.
  - **Session marker.** The gateway sets `JINN_PROJECT_ID` in a scoped session's environment.

  Excluded unless shared:
  - the company `knowledge/state.md`;
  - `knowledge/employees/`;
  - `docs/`;
  - every other company path.
- **FR-029**: `knowledge/projects/<id>/INSTRUCTIONS.md` is written into the stage dir as
  `CLAUDE.md`. Appending the company `CLAUDE.md` is a per-project opt-in
  (`instructions: project+company`). The default is project only. The generated file always
  ends with a fixed paragraph saying that:
  - the session is scoped to P;
  - it uses the jinn tools for company state;
  - it does not read `$JINN_HOME`, other repos or other sessions' transcripts with its shell;
  - it keeps project state in `knowledge/projects/<id>/state.md` through the note tools.

  The shipped template docs name only the jinn tools. `mem` is an instance-local script, not
  part of the product. Making the instance's `mem` respect `JINN_PROJECT_ID` (defaulting to the
  project's state file and refusing others) is a separate instance task, outside this
  repository.
- **FR-033**: **Working-directory validation.** A project working directory MUST:
  - be inside a git work tree whose top level is neither `$HOME` nor an ancestor of it;
  - not be, or be an ancestor of, `$HOME`, `$JINN_HOME`, the stage root or `~/.claude`;
  - not lie inside `$JINN_HOME`, the stage root, `~/.claude`, `~/.ssh`, `~/.config`,
    `~/.aws`, `~/.gnupg` or `~/Library`.

  The scan and the Projects page refuse a violating entry.

**Claude account per employee**: not in this feature. See "Employees on another Claude
account".

**Compatibility**

- **FR-035**: Unscoped employees and company Todos MUST behave as they do today:
  - every existing route, tool and engine launch does what it does on `main`;
  - wire changes are limited to additive, nullable fields;
  - the core MCP manifest is unchanged, checked by the attested hash in
    `tool-manifest-budget.test.ts`;
  - with no project files there are no projects and nothing is logged. The registry
    tolerates a missing `projects/` directory. The file watcher creates the empty directory
    at start, because chokidar cannot reliably watch a directory that does not exist yet, and
    an empty directory changes no behaviour;
  - adding `projects` to `ARCHIVE_INCLUDES` adds at most an empty directory to a backup.
- **FR-036**: The core MCP manifest MUST NOT grow. Scoped callers get their project from the
  binding, and `parentId` sub-tasks inherit their parent's. Only the operator, through REST or
  the UI, files a Todo directly into a chosen project.

**UI and verification**

- **FR-040**: These elements MUST be captured in light and dark, with screenshots on the PR:
  - the project switcher;
  - the board filter chip, the card badge and the list badge;
  - the project field on create and on the detail rail;
  - the Projects page;
  - the org tree's project badges and filter;
  - the employee scope control;
  - the new-chat project picker;
  - the session badges.
- **FR-041**: The org tree MUST show each employee's projects as badges, with `all` shown as
  no badge. It MUST offer a project filter that narrows the tree to that project's members.
- **FR-042**: The UI MAY edit projects and scope. When it does:
  - it writes the YAML, as `PATCH /api/org/employees/:name` writes the employee's YAML today;
  - each write is atomic: a temp file in the same directory, then a rename;
  - the in-memory registry is refreshed before the response returns, so a Todo created
    straight after a project is created never sees "unknown project".

  Hand-edited YAML stays the source of truth. The UI never holds state the files do not.

### Employees on another Claude account (not built here)

The operator cancelled the separate account spec on 2026-10-06. A project's employees run on
another Claude account through the existing per-employee profile setting,
`remoteClaudeConfigDir` (fact 4 in "What the tree does today"), so this feature builds nothing
for it.

One rule from this feature still applies. Every prompt, tool output and file read in a session
on another account goes to that account. Put an employee on another account only once it is
scoped and Phase 3's stage dir is in place. Otherwise the company `CLAUDE.md`, the skills and
client context leave the company.

research.md keeps its findings on what assumes a single local account (the rows from
`shared/home.ts:34` on), in case local sessions ever need a profile of their own.

### Deferred to future sandbox work (withdrawn from this feature by Q1 = A)

These items belong to the operator's separate sandboxing work and are not built here.
research.md keeps the findings and the Phase 0 checklist, so that work does not start from
zero.

- An allow-listed engine environment without `JINN_GATEWAY_TOKEN`, plus secret references by
  name (the old FR-021 and FR-030 to FR-032).
- Default-deny reads under `$HOME`, plus blocking process inspection (the old FR-022).
- `--strict-mcp-config` and connector exclusion (the old FR-023).
- Stopping capability derivation (the old FR-024).
- Making `authRequired` a precondition, hardening the exempt routes, and carrying the hook
  relay's context on argv (the old FR-025 and FR-025a).
- The escape script, E1–E15.
- A separate OS user (the old Q1-C).

### Key Entities

- **Project** (YAML): stable id, name, description, archived, dedicated, working directories,
  skill allow-list, shared Notes, instructions mode.
- **Project membership** (registry): a top-level Todo belongs to at most one project id.
  Sub-tasks inherit it.
- **Employee project scope** (employee YAML): `all`, or an explicit set of project ids, which
  may be empty.
- **Session project binding** (registry): present only on sessions of scoped employees, and
  fixed at creation.
- **Project stage directory**: a generated cwd for each project, outside `$JINN_HOME`.

## Success Criteria *(mandatory)*

- **SC-001**: Every row of the scoped-caller table has an allow test and a refuse test against
  the real API handler. A route-enumeration test fails on any route that is not classified.
- **SC-002**: Unscoped behaviour is unchanged:
  - the existing suite passes;
  - the manifest hash test is untouched;
  - a one-off comparison of `buildContext` output and engine argv between `main` and the
    branch, for a fixed unscoped roster, is recorded as PR evidence. It is not committed as a
    fixture.
- **SC-003**: Withdrawn. Employees on another account use the existing profile setting.
- **SC-004**: The token counts in `tool-manifest-budget.test.ts` do not rise.
- **SC-005**: Every FR-040 element has light and dark screenshots on the PR.

## Assumptions

- Single operator, single machine, single OS user. Scoping is a gateway guardrail, not an OS
  boundary (see "Scope of the boundary").
- Concurrent employees in one project share its working directories. Worktrees remain the
  answer.
- Personas do not vary per project. A different role means a separate employee.
- There is no client layer above projects, and nothing is reserved for one.
- Cron stays company-level in v1.
