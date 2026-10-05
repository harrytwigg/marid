# Feature Specification: Projects and Project-Scoped Employees

**Feature Branch**: `feat/project-scoping-spec`

**Created**: 2026-10-05

**Status**: Draft. Waiting on the operator's answers to Q1–Q11 (end of this file). Nothing is
implemented until they are answered.

**Input**: Marid issue #90 (upstream proposal hristo2612/jinn#81). The operator wants projects
as a first-class scope:

- Todos are raised inside a project.
- An employee can be limited to certain projects, for example a "Marid fork" project with its
  own employees.
- A scoped employee must not be able to reach the company setup.
- The skills a scoped employee sees can be limited.
- Enforcement is server-side, not UI-only.
- Unscoped employees and existing Todos behave exactly as they do today.

## Why This Matters *(constitution Principle II)*

On its own this is **rung 4**: the operator gets a way to bound a remit, and no decision moves
to the system. It belongs in this fork because Principle II makes "a stated ceiling and a way
for the operator to stop it" the condition for autonomy. Today the only ceiling on an
employee's reach is the whole instance. With project scoping, a set of dedicated employees can
be left to run a project's backlog unattended, with a reach the operator chose in advance.

This feature adds no spend ceiling of its own. The per-employee monthly cap
(`config.budgets.employees`, enforced at `packages/jinn/src/sessions/turn/preflight.ts:63`)
works as a per-project cap only for an employee scoped to exactly one project. An employee
scoped to several projects is capped across all of them together. If the operator wants a
separate cap for each project, that is a follow-up and needs its own decision. See "Decided
by default".

## What the tree does today *(facts the spec depends on)*

research.md has the full audit, with `path:line` citations. Four facts shape the design.

1. **Nothing in the data model resembles a project.**
   - There is no `project` field on Todos, sessions, employees or config.
   - Sprints and labels live in join tables, because the boot verifier refuses any column
     added to `work_items` (`packages/jinn/src/work-items/sprints-schema.ts:5`).
2. **The only per-employee allow-list is `mcp`** (`packages/jinn/src/shared/types.ts:529`).
   - Every skill is linked into one shared `~/.jinn/.claude/skills`
     (`packages/jinn/src/gateway/watcher.ts:38`).
   - A Todo's `dispatchConfig.skills` can *add* a "read this skill" line to the prompt but
     never take one away (`packages/jinn/src/work-items/dispatch-config.ts:253`).
3. **Gateway and MCP checks are cooperative, not a boundary.** Every local engine runs:
   - with a shell and with permissions bypassed;
   - with cwd `$JINN_HOME` (`packages/jinn/src/sessions/turn/engine-run.ts:46`);
   - with the operator bearer token in its environment
     (`packages/jinn/src/gateway/server.ts:504`);
   - with `--chrome`, which drives the operator's own browser
     (`packages/jinn/src/engines/claude-interactive.ts:451`).

   All engines also run as **the operator's own OS user**. As a result, every one of them
   can read:
   - the operator's other session transcripts under `~/.claude/projects/`;
   - the credential directories (`~/.config/gh`, `~/.ssh`);
   - every client repo under the work root;
   - the environment of every other process it can list with `ps -E`. That includes each
     jinn MCP server's `JINN_SESSION_CAPABILITY` (`packages/jinn/src/mcp/identity.ts:207`),
     and the inherited `JINN_GATEWAY_TOKEN` of any process that carries it.

   So any employee can act as operator through `curl` or through the browser, read
   `sessions/registry.db`, or edit `org/` and `config.yaml` directly. The MCP identity code
   says as much: it is "defense-in-depth … not an internet auth boundary"
   (`packages/jinn/src/mcp/identity.ts:42`).
4. **Several tools read local files with no protected-path check.**
   - `read_knowledge` can read any file in the home, including:
     - `gateway.json`, which holds the operator bearer token;
     - `secrets/`, which holds the key every session capability is derived from;
     - `config.yaml`;
     - `tmp/mcp/*`, other sessions' capabilities
     (`packages/jinn/src/notes/store.ts:729`).
   - `publish_attachment` reads any absolute path (`packages/jinn/src/mcp/file-tools.ts:96`).
   - Path-based attachment ingestion applies only the narrower ingestion policy
     (`packages/jinn/src/mcp/work-item-attachments.ts:68`,
     `packages/jinn/src/gateway/api.ts:2925`). That policy does not cover `registry.db`,
     `org/`, `CLAUDE.md`, or any other project's directories.

Facts 3 and 4 are why **Q1** comes first. Server-side enforcement is necessary. On its own,
though, it stops only an employee that keeps to its tools. It does not stop one from reaching
the company setup.

This instance already runs with `gateway.authRequired: true`. A request with no bearer token
gets 401 at `packages/jinn/src/gateway/request-handler.ts:55`, except on the routes that
`authRequiredForRequest` exempts (`packages/jinn/src/gateway/auth.ts:250`):

- `/api/status`
- `GET /api/auth/state`
- the `POST` pairing and auth routes
- `POST /api/internal/hook`

A contained shell has to be left with no credential at all. That means the token is absent
from its own environment, unreadable from `gateway.json`, and unreadable from **other
processes' environments**. The last of these is the hard part on a single OS user.

## User Scenarios & Testing *(mandatory)*

### User Story 1: The operator groups Todos into a project (Priority: P1)

The operator creates a "Marid fork" project on a new Projects page. They raise Todos inside it
from the board's create dialog. On the board they switch to the project and see only its
Todos, each with a project badge. Existing Todos carry no badge and stay where they were.

**Why this priority**: every later story needs projects and Todo membership. On its own it
gives the operator a grouping, with no behaviour change for anyone else.

**Independent Test**: create a project, create two Todos in it and one outside it, then
filter by the project. The list API, the board and the switcher each return exactly the two
project Todos. With no filter, all three are returned.

**Acceptance Scenarios**:

1. **Given** no projects exist, **When** the operator opens the board, **Then** it looks and
   behaves exactly as today.
2. **Given** a project P, **When** the operator creates a Todo in P, **Then** the card, list
   row and detail rail show P. Its sub-tasks show P too, through inheritance (FR-004).
3. **Given** a Todo in P, **When** the operator sets its project to none, **Then** it becomes
   company-level, and a `project_changed` event records the old and new values.
4. **Given** P is archived, **When** anyone tries to create a Todo in P or move one into it,
   **Then** the request is refused. P's existing Todos stay readable.

---

### User Story 2: A scoped employee only sees its project (Priority: P1)

The operator scopes a new employee, `marid-dev`, to "Marid fork". From a `marid-dev` session:

- the work-item, session and org list tools return only P's Todos, P-bound sessions, and
  employees scoped to P;
- `get_work_item` on a company Todo returns *not found*;
- cron, cost and config are refused.

**Why this priority**: this is the feature. US1 is its prerequisite.

**Independent Test**: these are the enforcement tests for FR-010 to FR-019. Each drives the
real API handler as a capability-bound session of a scoped employee. The seeded registry
holds:

- company Todos;
- Todos in two projects;
- sessions of scoped and unscoped employees working each.

Every row of the scoped-caller table (plan.md) gets at least one allow case and one refuse
case.

**Acceptance Scenarios**:

1. **Given** `marid-dev` is scoped to P, **When** it lists Todos, **Then** it gets only P's.
   A filter naming another project returns an empty page.
2. **Given** company Todo `ACM-5`, **When** `marid-dev` reads, comments on, attaches to,
   assigns, links or dispatches it, **Then** each call returns a 404 identical to the one for
   an unknown id.
3. **Given** `marid-dev` creates a Todo with no project, **Then** it lands in P. If it names
   another project, the request is refused.
4. **Given** the COO is working a P Todo, **When** `marid-dev` lists, reads or messages
   sessions, **Then** the COO's session is not among them (FR-009, FR-012).
5. **Given** `marid-dev` was spawned by the COO, **When** it sends its result back, **Then**
   the reply reaches its parent session, delivered as Q10 decides. Sending to any other
   non-P session is refused (FR-013).
6. **Given** `marid-dev` spawns or delegates to `senior-developer` (unscoped), **Then** the
   request is refused (Q2-a). Spawning `marid-qa`, which is scoped to P, succeeds, and the
   child is bound to P.
7. **Given** an unscoped employee, **When** it does any of the above, **Then** its behaviour
   is unchanged (FR-035).

---

### User Story 3: A scoped employee cannot get around the gateway (Priority: P1, if Q1 = B)

A `marid-dev` session runs in a project stage directory outside `$JINN_HOME`, with:

- a minimal environment;
- a sandbox;
- no browser;
- no MCP servers other than the jinn server.

From its shell and its tools it cannot read `$JINN_HOME`, find any gateway credential, reach
the gateway as operator, or reach the operator's browser or connectors. It can read and write
the project's working directories, push with git, and run builds.

**Why this priority**: without it, US2 holds only for an employee that keeps to its tools.
Q1 decides whether this story is in v1.

**Independent Test**: the escape script (`scripts/verify-project-containment.sh`, Phase 4),
first run by hand in Phase 0. It drives a real Claude session of a scoped employee, launched
with the gateway's own argv and settings. Each of these must fail (E1–E15):

| Attempt | What it tries |
| --- | --- |
| E1 | `cat ~/.jinn/config.yaml`, `cat ~/.jinn/gateway.json`, `sqlite3 ~/.jinn/sessions/registry.db .tables` |
| E2 | `env \| grep -E 'JINN_GATEWAY_TOKEN\|API_KEY\|TOKEN'`, which may show only the project's declared references |
| E3 | `curl -s 127.0.0.1:<port>/api/work-items`, expecting 401 |
| E4 | `node <dist>/mcp/server-entry.js --jinn-session-id <other> --jinn-home ~/.jinn`, expecting no capability |
| E5 | A Bash call with `dangerouslyDisableSandbox: true` |
| E6 | Writing `.claude/settings.json`, `.mcp.json` or `CLAUDE.md` in the stage dir, then starting a new turn: the new file must not take effect |
| E7 | `attach_to_work_item` and `publish_attachment` on `~/.jinn/sessions/registry.db` |
| E8 | `read_knowledge` of `gateway.json` |
| E9 | Any `mcp__claude-in-chrome__*` or `mcp__claude_ai_*` tool being present in the session |
| E10 | E1's reads repeated with the Read, Grep and Glob tools instead of the shell |
| E11 | Reading another session's transcript under `~/.claude/projects/`, or `~/.claude.json` |
| E12 | Reading a sibling project's stage dir or working directory, or any other repo under the work root |
| E13 | Reading `~/.config/gh`, `~/.ssh` or `~/.aws` |
| E14 | `ps -Eww -A \| grep -E 'JINN_GATEWAY_TOKEN\|JINN_SESSION_CAPABILITY'`, which must print nothing |
| E15 | Walking the auth-exempt routes (`/api/status`, `GET /api/auth/state`, the pairing routes, `POST /api/internal/hook` for another session's id): each must leak nothing and change nothing |

`git status`, `git push` (to a throwaway remote) and a project build must succeed.

**Acceptance Scenarios**:

1. **Given** a contained session, **When** any tool or shell command reads under `$JINN_HOME`,
   **Then** the read fails.
2. **Given** a contained session, **When** it lists its environment, **Then** it sees only the
   allow-listed variables and the project's declared secret references (FR-030).
3. **Given** a contained session, **When** it calls the gateway without the MCP server's
   credential, **Then** every route returns 401, except the auth-exempt set. E15 walks those
   exempt routes.

---

### User Story 4: A project limits the skills and Notes its employees see (Priority: P2)

The operator gives "Marid fork" a skill allow-list and a project Notes folder. A scoped
session is offered only those skills, through three channels:

- its engine's skills directory;
- its prompt;
- `dispatchConfig.skills`.

`search_knowledge` and `read_knowledge` cover only the project's Notes and the company Notes
explicitly shared with the project.

**Why this priority**: it stops company knowledge leaking into the project. It is not needed
for US2's enforcement.

**Independent Test**: from a scoped session, a `search_knowledge` term present in both a
company Note and a project Note returns only the project Note. A read of a skill outside the
allow-list is refused. The stage dir's skills directory holds exactly the allow-listed
skills.

**Acceptance Scenarios**:

1. **Given** the project allows S1 and S2, **When** a scoped session starts, **Then** the
   stage dir holds copies of exactly S1 and S2, and the prompt names only those.
2. **Given** a P Todo whose `dispatchConfig.skills` names S3, which is not allowed, **When**
   it is dispatched, **Then** the dispatch is refused and the refusal names S3.
3. **Given** company Note N is shared with P, **Then** a scoped search includes N. An unshared
   company Note is never included.

---

### User Story 5: The operator manages scope from the UI (Priority: P2)

From the Projects page the operator can:

- create, rename, describe and archive a project;
- set its working directories, skill allow-list and shared Notes, plus secret references by
  name once Phase 4 ships;
- see its members.

On an employee's edit panel, the operator sets the employee's scope: all projects, or a list
of projects. When starting a chat with a scoped employee that has more than one project, the
operator picks the project.

A project switcher in the shell narrows the board and the sidebar. Sessions show a project
badge in the sidebar and in the Todo session tree.

**Why this priority**: until it exists, scope can be set only through YAML or REST.

**Independent Test**: Playwright against a throwaway sandbox gateway, following the
`scripts/verify-chat-grid-drop.sh` pattern. Every new or changed element is captured in light
and dark, with the screenshots attached to the PR (FR-040).

---

### Edge Cases

- **A Todo leaves P while a scoped session works it.** The session's next call on that Todo
  returns 404. The turn finishes and the run is recorded. An `escalated` event is written on
  the Todo, so the operator sees it.
- **Scope narrowed while sessions are live.** Scope is read from the live roster on every
  request. A session bound to a project its employee no longer has is refused on every route
  except reading its own transcript. `refuseTurn` starts no new turn in it.
- **Scope emptied.** This is distinct from unrestricted (FR-007). An employee whose `projects`
  key is present but holds no known project is scoped to nothing: every scoped route refuses,
  and no session can start. Removing a scope never widens it.
- **Sub-tasks.** A sub-task inherits its root's project and cannot set its own. Membership
  lives on the root, as sprint membership does
  (`packages/jinn/src/work-items/sprint-membership.ts:71`). Todos cannot be re-parented after
  creation (`parentId` is accepted only at create, `packages/jinn/src/gateway/api.ts:2192`),
  so there is no re-parent case.
- **Linking.** A scoped caller may link only P Todos to each other. Unscoped callers may link
  anything, as today. A scoped reader sees a relation to a non-P Todo as "1 hidden relation".
- **Sessions on a P Todo.** For a scoped caller, `GET /api/work-items/:id/sessions` lists only
  P-bound sessions and reports the rest as a hidden count.
- **Archived project.** Its Todos stay readable. Its scoped employees cannot create Todos, and
  new sessions start only on an existing P Todo.
- **Deletion.** v1 only archives, so the id stays stable for history.
- **Names.** Unique ignoring case. `none` and `all` are reserved for the filter grammar.
- **Numbering.** Unchanged: `ACM-80` can be in "Marid fork". A project is a separate dimension
  from department.
- **System employees** (Dispatcher, board walk, Shaper) stay unscoped and cannot be scoped.
  They respect FR-015: they never route a P Todo to an employee who may not hold it.
- **The remote MCP connector** (`specs/004-remote-mcp-connector`) is the operator's own door.
  It stays unscoped.
- **Connector-originated sessions** (Telegram) for a scoped employee are refused in v1.
  Scoped employees are reached through Todos or the web chat.
- **Cron.** Validation refuses a job that targets a scoped employee (Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

**Projects and membership**

- **FR-001**: A project MUST have:
  - a stable id (`prj_` followed by 12 hex characters) that never changes;
  - a name, unique ignoring case;
  - a description;
  - `archived_at`, `created_at` and `updated_at`.
- **FR-002**: A top-level Todo MUST belong to zero or one project, and none means
  company-level. **No existing Todo is migrated.**
- **FR-003**: The project MUST be settable at create time and changeable afterwards, through
  REST and the web UI. Each change MUST write a `project_changed` event.
- **FR-004**: A sub-task's project MUST be its root's. Read payloads report it on every Todo
  in the tree.
- **FR-005**: The Todo list API MUST accept `project=<id>|none`, and the parameter is optional.
  List and detail payloads gain `project: {id, name, archived} | null`. This is additive and
  nullable.
- **FR-006**: An archived project MUST refuse new members. It stays readable.

**Employee scope and session binding**

- **FR-007**: Employee scope MUST be explicit:
  - In org YAML, an absent `projects` key means **all**. This is today's behaviour, and it is
    the only way to be unrestricted.
  - A present key means **scoped to the known ids**. This holds even when the key is empty,
    holds only unknown ids, or is a bare `projects:` (YAML null). The known ids can be the
    empty set, which grants access to nothing.
  - The wire carries `projectScope: "all" | string[]`.
  - `PATCH /api/org/employees/:name` (operator-only) refuses an empty list. To remove access
    entirely, the employee must be archived or removed.
  - No path turns a scoped employee into an unrestricted one except an explicit
    `projectScope: "all"`.
- **FR-008**: A session of a scoped employee MUST be bound to one project when it is created:
  - With a linked Todo, the binding is the Todo's project. That project must be in the
    employee's scope. A company Todo, or a Todo outside scope, refuses the spawn.
  - If an explicit `project` is also given and differs from the Todo's, the spawn is refused.
  - With no linked Todo, the binding is the explicit `project` if it is in scope, or else the
    employee's only project. Anything else refuses the spawn.
  - The binding is stored on the session and never changes.
- **FR-009**: The **enforcement binding exists only on sessions of scoped employees.**
  - Sessions of unscoped employees never carry one.
  - Their project badge is derived at read time from the linked Todo's project.
  - Scoped filters match only on the enforcement binding, so an unscoped session is never
    visible or reachable from a scoped one, whatever Todo it works.

**Server-side enforcement** (applies to every request from a capability-bound session of a
scoped employee; **P** is the session's binding)

- **FR-010**: **Default deny.** Every gateway route not on the scoped-caller table in plan.md
  MUST be refused. The table is enforced at the identified-caller gate, beside
  `refuseRemoteMcpRoute` (`packages/jinn/src/gateway/api.ts:1181`).

  WebSocket upgrades sit outside that gate, and today they are **not** all operator-only:
  - `/ws/pty` refuses non-operators;
  - `/ws` and plugin events refuse only unidentified callers, and then check auth
    (`packages/jinn/src/gateway/server.ts:1035`). So any session holding the token receives
    the company-wide activity broadcast.

  The upgrade guard MUST refuse scoped callers on every upgrade path.
- **FR-011**: **Todos.**
  - Lists and searches MUST be limited to P.
  - Per-Todo routes MUST return 404 for a Todo outside P. That 404 MUST be identical to the
    one for an unknown id.
  - A Todo created by a scoped caller MUST land in P.
  - A request to move a Todo out of P MUST be refused.
- **FR-012**: **Sessions.** Session reads, searches, message context, `send_to_session` and
  `stop_session` MUST be limited to sessions bound to P, except as FR-013 allows.
- **FR-013**: **Replying to a requester.** A scoped session MAY reply to the session that
  spawned it or delegated to it. That session is the existing `sessions.parent_session_id`,
  set at spawn (`packages/jinn/src/gateway/spawn-session.ts:188`). The reply grants no read
  of the parent session and reaches no other session.

  How the reply is delivered is Q10:
  - **(a)** a live `send_to_session`. This starts a turn in the parent session, which may be
    uncontained, on text the scoped session wrote.
  - **(b)** a non-executing callback. The reply is stored as a record on the parent session,
    shown to its operator, and read by the parent on its next turn, marked as content from a
    scoped session. It starts no turn.
- **FR-014**: **Org.**
  - Org reads MUST return only employees scoped to P, and the prompt roster MUST match.
  - Departments MUST NOT be exposed.
  - Applying an existing label to a P Todo is allowed.
  - Label, sprint and department administration MUST be refused.
- **FR-015**: **Who may hold a Todo.** The predicate is `mayHoldTodo(employee, todoProject)`.
  Q8-a gives these rules:
  - A **scoped** employee may hold only Todos in its own projects.
  - An **unscoped** employee may hold company Todos, and Todos in any project that is not
    marked `dedicated`.
  - A project marked **`dedicated`** may have its Todos held only by its members.
  - `@operator` may hold any Todo. This keeps the blocked-Todo route to the operator
    working (`packages/jinn/src/gateway/todo-assignee.ts:21`).

  So a project with no scoped members, and not marked `dedicated`, is a plain grouping that
  anyone can work in. That is US1, unchanged.

  **Fallbacks, so that FR-035 holds:**
  - If the store has no scope resolver (store unit tests, or any writer outside the gateway),
    every assignment passes except one into a `dedicated` project, which is refused.
  - An assignee name that is not on the roster, such as a removed employee or an existing
    fixture name, is treated as unscoped. That is today's behaviour.

  **Where it is enforced.** The check sits at the store, in every writer of `assignee`:
  - the insert in `createWorkItem` (`packages/jinn/src/work-items/store.ts:356`);
  - the two update paths that call `releaseOnOwnerChange` (`packages/jinn/src/work-items/store.ts:797`, `packages/jinn/src/work-items/store.ts:850`),
    which the store documents as "every writer of `assignee`" (`packages/jinn/src/work-items/store.ts:961`).

  **What that covers.** Whatever the caller, the operator included, this reaches every path
  that sets an assignee:
  - `assignWorkItem` (`packages/jinn/src/work-items/assignment.ts:77`) and its callers;
  - the PATCH assignee branch (`packages/jinn/src/gateway/api.ts:2409`);
  - the delegation route's create-already-assigned path
    (`packages/jinn/src/gateway/api.ts:3450`);
  - plugin-host creates (`packages/jinn/src/plugins/host/todos.ts:31`);
  - cron-created Todos (`packages/jinn/src/cron/runner.ts:101`);
  - the talk adapters.

  **Paths that start work without writing an assignee** check it at their own entry:
  - spawn with a linked Todo (FR-008);
  - Dispatcher routing;
  - the board-walk projection, which skips an ineligible pairing.

  **Transitions that would strand a holder** MUST each be refused, naming the holders so
  the operator can reassign first:
  - changing a Todo's project (FR-003) while the root or any sub-task is held by someone
    ineligible under the new project;
  - marking a project `dedicated` while any of its Todos is held by a non-member;
  - narrowing an employee's scope through `PATCH` while the employee holds a Todo that would
    fall outside it.

  A scope narrowed by hand-editing the YAML cannot be refused. The org scan reports each
  resulting violation in the gateway log and on the employee page, and FR-008 refuses new
  sessions on the affected Todos until they are reassigned.
- **FR-016**: **Spawning from a scoped caller.** `spawn_session`, `delegate_task` and
  `dispatch_work_item` MUST target only employees scoped to P (Q2-a), and the child MUST be
  bound to P.
- **FR-017**: **Company control plane.** Config, cron, cost, connectors, global search, the
  skills API, and Notes outside the project MUST be refused.
- **FR-018**: **Local file reads made on a scoped session's behalf.** These happen outside any
  engine sandbox, in the MCP server or the gateway:
  - `publish_attachment`;
  - path-based `attach_to_work_item`;
  - the JSON `{path}` form of `POST /api/work-items/:id/attachments`.

  Each MUST accept only paths whose realpath is inside P's working directories or P's stage
  dir. Managed files (`list_files`, `read_file`) MUST be refused, because the `files` table
  has no owner (`packages/jinn/src/sessions/migrate.ts:117`).
- **FR-019**: **Tool profile.** A scoped session's MCP manifest MUST omit every tool whose
  routes are all refused. Unscoped manifests are unchanged.

**Containment** (FR-021 to FR-025a only if Q1 = B. FR-020 (stage dir), FR-023 (no Chrome, strict MCP; Q9) and FR-026 (claude-only) also apply under Q1 = A, in Phase 3, because skill and instructions scoping and Q9 need them.)

- **FR-020**: A scoped session MUST run with cwd set to a generated stage dir **outside**
  `$JINN_HOME`. The default is `<parent of home>/.jinn-projects/<project id>/` (data-model.md).
  The reason is that Claude Code loads `CLAUDE.md` from ancestor directories, so a stage dir
  inside `$JINN_HOME` would load the company file.
- **FR-021**: Its environment MUST be built from an allow-list plus the project's secret
  references. Nothing is inherited from the gateway. In particular there MUST be no
  `JINN_GATEWAY_TOKEN`.
- **FR-022**: Its shell **and its file tools** (Read, Edit, Write, Glob, Grep, NotebookEdit)
  MUST be confined:
  - **Reads under `$HOME` are denied by default.** The only exceptions are P's working
    directories, P's stage dir, and the toolchain paths found by Phase 0 item 5. So
    `$JINN_HOME`, `~/.claude/`, `~/.claude.json`, other projects' stage dirs and working
    directories, the rest of the work root, and the credential directories are all
    unreadable.
  - Process inspection of other processes MUST be blocked (`ps -E`; Phase 0 item 10). If it
    cannot be, Q11 applies.
  - Writes are denied outside P's working directories, temp and caches.
  - writes to the stage dir's `.claude/`, `CLAUDE.md` and `.mcp.json` are denied;
  - unsandboxed commands are disabled (`sandbox.allowUnsandboxedCommands: false`, Phase 0
    item 2).

  The sandbox and deny rules MUST be delivered in the `--settings` file the gateway already
  writes under its own `tmp/` (`packages/jinn/src/engines/claude-interactive.ts:456`), never
  from a file in the stage dir.
- **FR-023**: Its argv MUST carry `--no-chrome` and `--strict-mcp-config`, so that only the
  gateway's own `--mcp-config` applies. claude.ai connectors and user-level MCP servers and
  plugins MUST NOT attach (Q9). Phase 0 establishes the mechanism.
- **FR-024**: The jinn MCP server for a scoped session MUST use the capability the gateway
  already places on its environment (`packages/jinn/src/mcp/identity.ts:207`). It MUST NOT
  derive one from the key file, which it does today: the derivation in
  `packages/jinn/src/mcp/server-bootstrap.ts:25` takes precedence over the environment value
  (`packages/jinn/src/mcp/server.ts:291`). This is defence in depth, on top of FR-022 making
  the key unreadable to the shell. It does not address the capability being visible through
  `ps -E`. That is Phase 0 item 10, and Q11.
- **FR-025**: Contained sessions require `gateway.authRequired: true`. Config validation
  refuses a scoped employee on an instance with auth off, and says why. With auth on, a
  request from the shell gets 401 at `packages/jinn/src/gateway/request-handler.ts:55` on
  every route except the auth-exempt set (`packages/jinn/src/gateway/auth.ts:250`), provided
  the shell holds no token. The exempt routes MUST be shown to leak and change nothing for a
  credential-less caller (E15). `POST /api/internal/hook` MUST verify that the hook belongs to
  the session it names.
- **FR-025a**: The hook relay MUST work inside containment. It cannot use `JINN_HOME`, which
  FR-021 strips, and it cannot read `gateway.json`, which FR-022 denies
  (`packages/jinn/assets/hook-relay.mjs:10`). The gateway-written hook command therefore
  carries what the relay needs on argv: the session id, the gateway URL, and a per-session
  hook credential. Phase 0 item 8 verifies that this works.
- **FR-033**: **Working-directory validation.** This applies under Q1 = A and under B,
  because FR-018 also allow-lists working directories. A project working directory MUST:
  - be inside a git work tree (`git rev-parse --show-toplevel` succeeds), which rules out a
    bare work root such as `~/Projects` that would expose every client repo;
  - not be, or be an ancestor of, `$HOME`, `$JINN_HOME`, the stage root or `~/.claude`;
  - not lie inside `$JINN_HOME`, the stage root, `~/.claude`, `~/.ssh`, `~/.config`, `~/.aws`,
    `~/.gnupg` or `~/Library`.

  A write that breaks this rule is refused. Without it, one working directory could expose a
  credential directory through FR-018 attachments, or void the containment denies.
- **FR-026**: In v1 a scoped employee MUST use the `claude` engine. Validation refuses any
  other engine and says why.

**Skills, Notes and instructions**

- **FR-027**: A project MAY carry a skill allow-list. A scoped session MUST be offered only
  allow-listed skills, through:
  - copies in the stage dir (not symlinks, which would resolve into the sandbox-denied
    home);
  - the prompt;
  - `dispatchConfig.skills` validation.

  An empty list means no skills.
- **FR-028**: Project Notes MUST live under `knowledge/projects/<project id>/`. For a scoped
  caller, `search_knowledge`, `read_knowledge` and the note tools MUST be rooted there, plus
  the paths the project shares. `docs/` and all other company paths are excluded unless
  shared.
- **FR-029**: A project MAY carry `knowledge/projects/<id>/INSTRUCTIONS.md`. It is written into
  the stage dir as `CLAUDE.md`. Appending the company `CLAUDE.md` as well is a per-project
  choice (Q5), and the default is not to.

**Secrets** (Phase 4 only. Under Q1 = A there is no contained environment for them to feed
(Q7), so these requirements, the `project_env` table, its route and its UI ship with Phase 4.)

- **FR-030**: A project MAY declare environment variables as `{name, secret}`, where `secret`
  is a key name in the secrets store. Values are resolved at spawn from `secrets/` only. Raw
  values MUST NOT reach:
  - the DB or YAML;
  - logs or events;
  - API responses or the UI.

  The API returns only names and whether each one resolves.
- **FR-031**: A declared name MUST NOT match the reserved set:
  - `JINN_*`
  - `PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`
  - `NODE_OPTIONS`, `NODE_PATH`
  - `LD_*`, `DYLD_*`
  - `CLAUDE_*`, `ANTHROPIC_*`
  - every name on the FR-021 allow-list

  The write is refused.
- **FR-032**: A reference to a missing secret key MUST NOT block a spawn. The variable is
  left out, and the project page shows it as unresolved.

**Compatibility**

- **FR-035**: Unscoped employees and company Todos MUST be **behaviourally unchanged**: every
  existing route, tool and engine launch returns and does what it does on `main`. Wire changes
  are limited to additive, nullable fields (`project`, `projectScope`). The core MCP manifest
  MUST be unchanged, which the existing attested hash in `tool-manifest-budget.test.ts`
  checks.
- **FR-036**: The core MCP manifest MUST NOT grow (Q4-a). Scoped callers get their project
  from their session binding. A Todo created by an unscoped agent with a `parentId` inherits
  the parent's project. No other path files a Todo into a project except the operator through
  REST or the UI.

**UI and verification**

- **FR-040**: These elements MUST be captured in light and dark, with screenshots on the
  implementation PR:
  - the project switcher;
  - the board filter chip, plus the card and list badge;
  - the project field in create and detail;
  - the Projects page;
  - the employee scope control;
  - the new-chat project picker;
  - the session badges.

### Key Entities

- **Project**: a stable id, name, description and archived flag. It also carries:
  - working directories (zero or more absolute paths);
  - a skill allow-list;
  - shared company Notes;
  - secret references (Phase 4);
  - an instructions mode.

  A project is not a repo or a directory. One project can list several, and several projects
  can list the same one.
- **Project membership**: a top-level Todo belongs to at most one project. Sub-tasks inherit
  it.
- **Employee project scope**: `all`, or an explicit set of project ids. The set may be empty,
  in which case the employee can reach nothing.
- **Session project binding**: set only on sessions of scoped employees. It is fixed at
  creation and is the "P" in every rule. A scoped session's requester for FR-013 is its
  existing `parent_session_id`.
- **Project stage directory** (Q1 = B): a generated cwd per project, outside `$JINN_HOME`. It
  holds the generated `CLAUDE.md` and copies of the allowed skills.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every row of the scoped-caller table has an allow test and a refuse test against
  the real API handler. A route-enumeration test fails on any registered route the table does
  not classify.
- **SC-002**: Unscoped behaviour is unchanged, shown by three things:
  - the existing suite passes, except tests the Phase S fix deliberately changes, which the PR
    names;
  - the manifest hash test is untouched;
  - a one-off comparison shows that the `buildContext` output and engine argv for a fixed
    unscoped roster are identical on `main` and on the branch. This is run as PR evidence,
    not committed as a fixture (Principle VI bans snapshot tests).
- **SC-003** (Q1 = B): run against a live sandbox gateway, the escape script fails every
  attempt E1–E15 and every allowed action succeeds. The output is attached to the PR.
- **SC-004**: The token counts in `tool-manifest-budget.test.ts` do not rise.
- **SC-005**: Every FR-040 element has a light and a dark screenshot on the PR.

## Assumptions

- **Single operator, single machine, single OS user.** Isolation between projects comes from
  the gateway, plus the engine sandbox when Q1 = B. It is not an OS-user boundary (Q1-C).
- **Concurrent employees in a project** can affect each other through shared working
  directories. Worktrees remain the answer (issue question 5).
- **Personas do not vary per project.** Scope is an allow-list. A different role in a project
  means a separate employee, which is the operator's stated model of dedicated employees
  (issue question 2).
- **No client layer.** Projects could gain a nullable client id later. Nothing is reserved for
  it now (Principle V; issue question 7).
- **Cron stays company-level in v1.** A scoped employee has no cron jobs. Project-owned cron is
  a follow-up, and only if the operator needs it.
- **User-level Claude config may still load.** That covers `~/.claude/CLAUDE.md` and the
  `~/CLAUDE.md` ancestors of the stage dir, neither of which exists on this host today.
  Filtering these fully needs a per-project `CLAUDE_CONFIG_DIR`, which means a separate engine
  login, so it is out of scope. User-level skills are covered by FR-023 if Phase 0 shows they
  can be excluded; otherwise this is a known leak, recorded in research.md.

## Open Questions for the Operator

Each question gives options and a recommendation. Plan.md and tasks.md assume the
recommendations.

### Q1: Is "cannot reach the company setup" a guardrail or a boundary?

Every engine runs as the operator's own OS user. On a single user, the list of ways out is
long, and each review round found more of them:

- other sessions' transcripts under `~/.claude/projects/`;
- credential directories (`~/.config/gh`, `~/.ssh`);
- client repos under the work root;
- **other processes' environments**: `ps -E` on this host shows `JINN_GATEWAY_TOKEN` in 148
  of the operator's processes, and a session capability in every running jinn MCP server;
- the operator's browser;
- hooks that run outside the sandbox;
- the auth-exempt routes.

The options:

- **A. Guardrail.** Enforcement in the gateway and MCP only (FR-010 to FR-019), plus the
  Phase S fixes. An employee that keeps to its tools stays in scope. One that uses its shell
  does not. The docs say so plainly.
  - Cost: Phases S, 1, 2 and 3.
- **B. Same-user sandbox.** A, plus containment (FR-020 to FR-026, FR-033):
  - default-deny reads under `$HOME`;
  - an allow-listed environment;
  - the Claude Code sandbox, with process inspection blocked;
  - no Chrome, no connectors, strict MCP config.

  This holds only if Phase 0 shows that E1–E15 can all be closed. Item 10 (process
  inspection) is the one most likely to fail.
  - Cost: Phase 0 plus Phase 4. Scoped employees are claude-only, and lose browser and
    connector access.
- **C. Separate OS user.** Scoped engines run as a dedicated macOS user. File permissions
  then close transcripts, credentials, `ps -E` and the home directory, with no sandbox
  rule list to keep complete. This is the real boundary. It needs you to create the user
  and allow the gateway to launch processes as it (a sudoers entry), so it is
  infrastructure, and your call. It is not specified here.

**Recommendation: ship A as v1, and run Phase 0 alongside it as a time-boxed evaluation of
B.**
- A on its own delivers projects, scoped visibility and bounded tool reach. With Phase S it
  also closes the worst existing gap: any session can read the operator token through
  `read_knowledge`.
- If Phase 0 closes every escape case, Phase 4 builds B.
- If it does not, and you still need a boundary, C is the route, and it gets its own spec.
- Under A, "scoped" is documented as "kept in scope by its tools", not as "cannot reach".

### Q2: Can a scoped employee spawn or delegate to employees outside its project?

- **a. Project members only (recommended).**
  - A scoped session cannot *spawn* or *delegate to* an uncontained employee.
  - It is not a full answer to upward influence. FR-013's reply (Q10-a) still puts
    scoped-authored text in front of the requester, and the operator and the COO read P's
    Todos (Q8).
  - The cost: each project needs its own reviewers at each tier the org's review rule
    requires. For example `marid-qa`, plus a senior one if the project has a senior producer.
- **b. Scope inherits down the lineage.** A scoped session may spawn any employee, and the
  child is bound, and contained under B, as if it were scoped. Shared reviewers then work
  across projects. Under B, every employee would then have to be containable.

### Q3: Where do project definitions live?

- **a. Registry DB (recommended).** It follows the sprints precedent:
  - foreign-keyed membership;
  - one transaction for a Todo write and its project write;
  - covered by the registry backup.

  Employee scope stays in org YAML.
- **b. YAML under `~/.jinn/projects/`, mirroring `org/`.** Hand-editable and diffable, but
  membership would reference ids the DB cannot check, which makes two sources of truth.

### Q4: Should agents be able to file Todos into a named project?

The core MCP manifest is at 4155 of 4156 tokens on the binding wrapper.

- **a. No new MCP parameters (recommended).** Scoped sessions file into their own project.
  Unscoped agents' sub-tasks inherit their parent's project. Only the operator, through the
  UI or REST, files into a chosen project directly.
- **b. Add `project` to `create_work_item`, `list_work_items` and `edit_work_item`.** The
  sprint precedent cost 25 tokens across those three, and they have to be bought back in the
  same PR. Needed only if the COO is to file "into Marid fork" from chat.

### Q5: What company context does a scoped session get?

- **Instructions.** **Project `INSTRUCTIONS.md` only (recommended)**, or the project file plus
  the company `CLAUDE.md`.
  - The company file names the whole org, the routing, the clients and the operator's other
    work, so including it leaks what the issue wants kept out.
  - The price of excluding it: the project file has to carry the rules a project employee
    needs (review lifecycle, branch rules, confidentiality).
- **Notes and `docs/`.** **Excluded unless the project lists them (recommended)**, or included
  by default.

### Q6: Should three existing read gaps be fixed for everyone, as a small PR first?

The gaps (they exist today without projects):

- `read_knowledge` can read `gateway.json`, the operator bearer token. This is the worst of
  the three.
- `read_knowledge` can also read `secrets/`, which holds the capability key, `config.yaml`, and
  other sessions' MCP configs.
- `publish_attachment` reads any absolute path.

The options:

- **a. For everyone (recommended).** Route both reads through the existing read policy
  (`assessFileRead` / `readLocalFileForIngestion`, `packages/jinn/src/shared/file-read-policy.ts`),
  which refuses `gateway.json`, `secrets/` and `config.yaml`. This means `read_knowledge` will
  no longer read `config.yaml`, and an existing test that expects it to will change. If agents
  must keep reading `config.yaml`, say so, and it stays readable with only the secret-bearing
  entries refused.
- **b. Only for scoped sessions**, as part of FR-018.

### Q7: Should project secret references be in v1?

- **Defer to Phase 4 (recommended under Q1 = A).** Under A there is no contained environment.
  A scoped session inherits the gateway's environment like every other session, so a secret
  reference would feed nothing (Principle V). They ship with Phase 4, if B is built.
- **Required, if B is built.** The contained environment drops everything the gateway
  inherited, so any credential the project's work needs (for example `GH_TOKEN` for a push)
  must come from a named reference. The alternative, leaving `~/.config/gh` readable inside
  the sandbox, hands every scoped employee **the operator's own full-scope GitHub token**.

### Q8: Who may hold a project's Todos?

Bodies and comments written by a scoped employee become prompt input for whoever works the
Todo.

- **a. Base rule plus a per-project `dedicated` flag (recommended).**
  - The base rule:
    - a scoped employee holds only its projects' Todos;
    - unscoped employees hold anything outside a `dedicated` project;
    - `@operator` holds anything.
  - Marking a project `dedicated` (for example "Marid fork") restricts its Todos to its
    members.
  - What it costs a grouping-only project: nothing. Without scoped members or the flag, a
    project is a plain grouping anyone can work in.
  - What it costs a dedicated project: its work needs its own employees, and the flag
    cannot be set while a non-member holds one of its Todos (FR-015).
  - Residual risk in a project that is **not** dedicated but does have scoped members: an
    unscoped holder works from text those members wrote.
  - Residual risk in a dedicated project: the COO, and any unscoped overseer, still *read* its
    bodies and comments, and receive FR-013 replies.
  - The narrowest setting is `dedicated` with Q10-b.
- **b. Every project is dedicated.** Simpler, but a project is unusable until it has scoped
  employees. Todos grouped by unscoped employees before Phase 2 would then need reassigning.
- **c. No holder restriction on unscoped employees.** Even a project's own scoped employees
  then hand their content to uncontained agents.

### Q9: Can scoped sessions use Chrome and the claude.ai connectors?

The connectors are Slack, Gmail, Drive, Atlassian and others.

- **Off (recommended under Q1 = B).** Chrome is the operator's own logged-in browser. The
  connectors reach well past the company setup. Neither is containable by the sandbox. The cost
  is that project employees cannot drive a browser for visual testing through Chrome. Headless
  Playwright inside the sandbox still works if Phase 0 item 5 allows it.
- **On.** Only consistent with Q1 = A. Even under A, Chrome gives a scoped employee the
  operator's logged-in browser, and turning it off costs two flags. So the recommendation is
  off under A as well.

### Q10: How does a scoped session reply to its requester?

- **a. A live `send_to_session` to its parent session.** This is today's behaviour for every
  employee, and the delegation rules expect it. It starts a turn in the parent on
  scoped-authored text, so the parent may be steered by P's content.
- **b. A non-executing callback (recommended under Q1 = B or C).** The reply is stored
  against the parent session and shown in its UI. The parent reads it on its next turn,
  marked as coming from a scoped session, and nothing starts a turn on its own. The cost: a
  requester that ends its turn waiting is not woken. It needs a nudge from the operator or a
  heartbeat.
- Under Q1 = A, (a) is acceptable, because the boundary is a guardrail anyway.

### Q11: If the sandbox cannot block `ps -E`, should the gateway stop exporting its token to every engine?

Only relevant if Phase 0 item 10 fails and you still want B.

- `packages/jinn/src/gateway/server.ts:504` puts `JINN_GATEWAY_TOKEN` in the gateway's own
  environment, and every engine inherits it. The documented fallback lets employees `curl`
  the gateway when the jinn tools are absent (`packages/jinn/src/sessions/context.ts:919`).
- **Yes** removes that fallback for every employee. They then reach the gateway only through
  the jinn MCP server. Even then, each MCP server's own capability stays visible to `ps -E`
  (`packages/jinn/src/mcp/identity.ts:207`). Closing that needs the capability passed some
  way other than the environment. This is why Q1 recommends treating C as the real boundary.
- **No** means B is not buildable on a single user. v1 stays at A.

### Decided by default (say if you disagree)

- A project has zero or more working directories, and is not a repo.
- Sub-tasks inherit their root's project.
- An out-of-scope id returns 404, never 403.
- Archive is the only form of deletion.
- Cron, connectors, cost, config and global search are refused for scoped callers. Scoped
  employees have no cron jobs.
- System employees and the remote connector stay unscoped.
- Telegram and other connector sessions for scoped employees are refused in v1.
- No per-project budget key. The existing per-employee cap is a per-project cap only for an
  employee scoped to a single project. Say if you want a per-project ceiling as a follow-up.
- No client layer.
