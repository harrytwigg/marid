# Feature Specification: Department-Scoped Employees and Per-Employee Claude Profiles

**Feature Branch**: `feat/project-scoping-spec`

**Created**: 2026-10-05. **Revised**: 2026-10-06, when the operator replaced projects with
departments and brought per-employee local Claude profiles into scope.

**Status**: Ready for implementation per plan.md and tasks.md. The operator's decisions are
recorded below and folded into the text.

**Input**: Marid issue #90 (upstream proposal hristo2612/jinn#81). The operator wants a scope
for a set of employees and their work:

- Todos are raised inside the scope, with their own board and numbering.
- An employee can be confined to that scope.
- A confined employee cannot reach the company setup through Jinn.
- Skills can be restricted per scope.
- A scope's employees can run on a different Claude account.

**The motivating case** is a friend who lets the operator use their Claude account for the
friend's side project, and only for that project. The operator:

1. makes a department for the side project and marks it `scoped`;
2. puts employees in that department and points them at a Claude profile signed in to the
   friend's account.

Existing employees still reach everything, the side project included, and can delegate into
it. The restriction runs one way only. That is configurable: a `dedicated` department is
closed to everyone except its own members.

## Operator decisions

### 2026-10-05

| Q | Decision | Effect on this spec |
| --- | --- | --- |
| Q1 | **A. Enforce through MCP and the gateway, plus the state files. No sandbox.** An agent that deliberately reads around the tools is not this feature's problem. It is discouraged in the scope's instructions. Proper sandboxing is future work | Containment is withdrawn and listed under "Deferred to future sandbox work". research.md keeps the findings for that work |
| Q2 | **a.** A scoped employee delegates only within its department. Unscoped employees, the COO included, reach everything | FR-016 |
| Q3 | "Whatever is the best architecture", plus "configuration via YAML is good" and "show it on the org tree" | Scope lives in `org/<department>/department.yaml` (FR-001). The org tree already groups by department |
| Q4 | No MCP parameter | FR-036 |
| Q5 | The scope's own instructions only | FR-029 |
| Q6 | **b.** Existing employees keep reading everything as today. The new restrictions apply only to scoped sessions | FR-018, FR-028 |
| Q7 | Falls away with Q1 = A: there is no contained environment for secrets to feed | Secrets are deferred with containment |
| Q8 | **a**, plus: employees in the scope must not be able to work on anything else | A scoped employee holds only its department's Todos. `dedicated` closes the department to everyone else (FR-015) |
| Q9 | Not fussed | Engine flags unchanged |
| Q10 | a (a live reply) | FR-013 |
| Q11 | Moot under Q1 = A | Withdrawn |

### 2026-10-06

| # | Decision | Effect on this spec |
| --- | --- | --- |
| D1 | **Departments, not a new project concept.** Departments already give a board, an id prefix and a group on the org tree. A `dedicated` department is the closed form | The project registry, project YAML, project membership table and Projects page are dropped. A department gains a `scope` (FR-001) |
| D2 | **Local employees can name their own Claude profile**, as remote employees already can | FR-050 to FR-059 |
| D3 | The separate account follow-up is cancelled. Its findings are folded into FR-050 to FR-059 | — |

**One choice this spec makes that the operator may override**: a scoped employee must run
locally (FR-026). Before D2, the only way to put an employee on another account was a remote
target, and a remote session cannot use the stage dir (research.md, "Remote targets"). With
local profiles that need goes away, so refusing `remoteHost` on scoped employees costs the
motivating case nothing.

## Why This Matters *(constitution Principle II)*

**Rung 4.** The operator gets a bounded remit for a set of employees, and a choice of which
account their work runs on. No decision moves to the system.

It belongs in this fork because it lets outside capacity, such as a friend's account, run a
department's backlog unattended, without the system mixing that work into the company's.

There is no spend ceiling of its own. The per-employee monthly cap (`config.budgets.employees`,
`packages/jinn/src/sessions/turn/preflight.ts:63`) applies as today. A friend's account is also
bounded by that account's own plan limits.

## Scope of the boundary *(read this first)*

Scoping is enforced **in the gateway and in the jinn MCP tools**. The gateway refuses a scoped
session's out-of-scope requests whichever tool makes them.

It is **not** an OS boundary. Every engine runs as the operator's macOS user and has a shell.
A scoped employee that deliberately uses its shell can still read `$JINN_HOME`, other repos
and credential directories. It can see other processes' environments, including the gateway
token, and call the gateway with that token. research.md ("Containment") records the full
list for the future sandbox work.

This feature responds in three ways:

- **It discourages shell access.** The department's instructions file says not to (FR-029).
- **It removes the easy paths.** The company `CLAUDE.md`, the company skills directory and the
  company state files are not loaded (FR-020, FR-027, FR-028), and the jinn tools refuse.
- **It keeps the docs honest.** Scoped employees are described as "kept in scope by the
  gateway", not "cannot reach".

**What goes to another account.** Every prompt, tool output and file read in a session on a
named Claude profile goes to that profile's account. Before Phase 3, a scoped session still
runs with cwd `$JINN_HOME` and loads the company `CLAUDE.md` and every skill. So an employee
on a friend's profile must be scoped **and** Phase 3 must have merged before it runs. Phase 4
enforces this: a named profile on a scoped employee is refused until the stage dir is in use
(FR-059).

## What the tree does today *(facts the spec depends on)*

research.md has the full audit, with `path:line` citations against `origin/main` at
`3c032251`.

1. **Departments are a label and a numbering, not a boundary.**
   - An employee has exactly one department: its YAML `department` field, falling back to its
     directory name (`packages/jinn/src/gateway/org.ts:81`). The two can disagree.
   - `org/<dept>/department.yaml` is documented but never read. The org walker skips it
     (`packages/jinn/src/gateway/org.ts:31`).
   - A Todo's department is `work_items.department`. It sets the id prefix
     (`packages/jinn/src/work-items/store.ts:331`), which never changes afterwards.
   - A department board is a plain `department=` list filter
     (`packages/jinn/src/work-items/store.ts:474`), not access control.
   - On this instance `gateway.todoDepartments` is unset, so departments are **open**: any
     writer can name a new slug, and assignment moves a Todo into the assignee's department
     (`packages/jinn/src/work-items/assignment.ts:72`). Assigning to `@operator` sets the
     department to null (`packages/jinn/src/gateway/api.ts:2650`).
   - Authority comes from the reporting tree, never from departments
     (`packages/jinn/src/gateway/work-item-authority.ts:25`).
2. **The only per-employee allow-list is `mcp`** (`packages/jinn/src/shared/types.ts:529`).
   Every skill is linked into one shared `~/.jinn/.claude/skills`
   (`packages/jinn/src/gateway/watcher.ts:38`), and local engines always run with cwd
   `$JINN_HOME` (`packages/jinn/src/sessions/turn/engine-run.ts:46`). So every session loads
   the company `CLAUDE.md` and every skill.
3. **The Claude account is global for local sessions.**
   - `resolveClaudeConfigDir` and `claudeJsonPath` read the gateway's own `CLAUDE_CONFIG_DIR`
     (`packages/jinn/src/shared/home.ts:34`, `:42`).
   - Only remote employees can name a profile, with `remoteClaudeConfigDir`
     (`packages/jinn/src/shared/types.ts:182`). Even that is dropped on ordinary turns:
     `engine-run.ts:55` and `rate-limit-turn.ts:166` pass the remote host, user and cwd but
     not the profile, so those turns fall back to the instance default.
   - About fifteen places assume one local profile: the child environment, the transcript
     readers, the trust seed, the auth outage ledger, engine health, the rate-limit memory and
     the limits snapshot. research.md lists them.
4. **Claude Code keeps one Keychain entry per profile.** The installed Claude Code (2.1.291)
   names its macOS Keychain entry `Claude Code-credentials` when `CLAUDE_CONFIG_DIR` is unset,
   and `Claude Code-credentials-<first 8 hex of sha256(config dir)>` when it is set. Signing a
   second profile in therefore does not overwrite the operator's login. Jinn reads only the
   unsuffixed name (`packages/jinn/src/shared/claude-models.ts:262`).

## User Scenarios & Testing *(mandatory)*

### User Story 1: The operator sets up a scoped department (Priority: P1)

The operator writes `org/side-project/department.yaml` with `scope: scoped`, and puts
`side-dev` and `side-qa` in `org/side-project/`. On the board the department appears with its
own prefix (for example `SID`) and a "scoped" badge. Its Todos are `SID-1`, `SID-2` and so on.
On the org tree the department's group shows the same badge.

**Independent Test**: with the YAML above, `GET /api/departments` returns `side-project` with
`scope: "scoped"` and members `side-dev` and `side-qa`. A Todo created in it gets the `SID`
prefix. No other department changes.

**Acceptance Scenarios**:

1. **Given** no `department.yaml` sets a scope, **When** anything runs, **Then** behaviour is
   exactly as today (FR-035).
2. **Given** `side-project` is scoped, **When** `senior-developer` (Engineering) is assigned
   `SID-3`, **Then** `SID-3` stays in `side-project`. It does not move to Engineering
   (FR-003).
3. **Given** `SID-3`, **When** the operator assigns it to `@operator`, **Then** it stays in
   `side-project`.
4. **Given** `SID-3`, **When** a sub-task is created under it naming `engineering`, **Then**
   the create is refused (FR-004).
5. **Given** the operator deletes `org/side-project/department.yaml`, **Then** the department
   stays scoped until a file says otherwise (FR-001).

---

### User Story 2: A scoped employee works only inside its department (Priority: P1)

From a `side-dev` session, the jinn tools return only `side-project`'s Todos, sessions bound
to it, and its members.

- Company Todos read as *not found*.
- Cron, cost, config and the org setup are refused.
- A company Todo cannot be assigned to `side-dev`.

**Independent Test**: the enforcement tests for FR-010 to FR-019. Each test drives the real
API handler as a capability-bound session of a scoped employee. The seeded registry holds
company Todos, Todos in two scoped departments, and sessions of both scoped and unscoped
employees. Every row of the scoped-caller table in plan.md has an allow case and a refuse case.

**Acceptance Scenarios**:

1. **Given** `side-dev` is in scoped department D, **When** it lists Todos, **Then** it gets
   only D's.
2. **Given** company Todo `ACM-5`, **When** `side-dev` reads, comments on, attaches to,
   assigns, links or dispatches it, **Then** it gets a 404 identical to an unknown id.
3. **Given** `side-dev` creates a Todo, **Then** it lands in D, whatever department it names.
4. **Given** the COO works a D Todo, **When** `side-dev` lists or reads sessions, **Then** the
   COO's session is not among them (FR-009).
5. **Given** the COO spawned `side-dev`, **When** `side-dev` replies, **Then** the reply reaches
   the COO (FR-013). Replies to any other session outside D are refused.
6. **Given** `side-dev` delegates to `senior-developer`, **Then** the request is refused. A
   delegation to `side-qa` succeeds.
7. **Given** anyone assigns a company Todo or another department's Todo to `side-dev`,
   **Then** the assignment is refused (FR-015).

---

### User Story 3: Existing employees reach in, unless the department is dedicated (Priority: P1)

The COO and the existing developers are unscoped. They see D's board, delegate a D Todo to
`side-dev`, or work one themselves.

When the operator sets `scope: dedicated`, only D's members can hold D's Todos. Existing
employees can still read and comment, but can no longer be assigned D's work.

**Independent Test**:

1. With D `scoped`, assigning a D Todo to `senior-developer` succeeds, and the Todo stays in D.
2. Changing D to `dedicated` through the API while `senior-developer` holds that Todo is
   refused, and the refusal names them.
3. After the Todo is reassigned, the change succeeds. Assigning a D Todo to
   `senior-developer` is then refused.
4. Unscoped behaviour on company Todos is unchanged throughout.

---

### User Story 4: Employees run on their own Claude profile (Priority: P1)

The operator signs a new profile in once (`CLAUDE_CONFIG_DIR=~/.claude-friend claude`, then
`/login`), and sets `claudeConfigDir: /Users/<operator>/.claude-friend` on `side-dev`.
`side-dev`'s sessions run on that account. Everything else runs on the operator's account as
before.

**Independent Test**: with two employees, one with `claudeConfigDir` set and one without, the
first's engine process has `CLAUDE_CONFIG_DIR` set to the profile, and the second's
environment is byte-identical to `main`. Resume, fork and the transcript API find the first
employee's transcript under the profile's `projects/` directory.

**Acceptance Scenarios**:

1. **Given** the profile is not signed in, **When** `side-dev` is started, **Then** the turn
   is refused with a message naming the profile and the login command (FR-054).
2. **Given** the friend's account hits its five-hour limit, **Then** only sessions on that
   profile wait. The operator's sessions keep running (FR-055).
3. **Given** the operator's account hits its limit, **Then** `side-dev` keeps running.
4. **Given** `side-dev` is rate-limited, **Then** its turn is not retried on another engine or
   another profile (FR-056).
5. **Given** a remote employee with `remoteClaudeConfigDir`, **When** it runs an ordinary
   turn, **Then** the turn uses that profile, not the instance default (FR-058).

---

### User Story 5: A department limits skills, Notes, instructions and state (Priority: P2)

The operator gives D a skill allow-list, an instructions file, and a Notes folder that
includes the department's own state file.

- A scoped session's engine sees only the allowed skills and the department's instructions,
  never the company `CLAUDE.md`.
- The jinn knowledge tools reach only the department's Notes and state, plus anything D
  explicitly shares. They never reach the company `state.md` or the employee state files.

**Independent Test**: from a scoped session:

- `read_knowledge` of `knowledge/state.md` returns 404;
- a `search_knowledge` term present in both a company Note and a D Note returns only the D
  Note;
- the session's cwd holds exactly the allowed skills and the generated `CLAUDE.md`.

---

### User Story 6: The operator sees scope and profiles in the UI (Priority: P2)

- **Board switcher:** each department shows its scope badge.
- **Org tree:** each department group shows its scope badge, and each employee on a named
  Claude profile shows a profile badge.
- **Department panel:** opened from the org tree group. It shows scope, members, working
  directories, skills, shared Notes, instructions mode and the YAML path, and edits them where
  FR-042 allows.
- **Session badges:** sessions bound to a scoped department show it.

**Independent Test**: Playwright against a throwaway sandbox gateway, following the
`scripts/verify-chat-grid-drop.sh` pattern. Every new or changed element is captured in light
and dark, with screenshots on the PR (FR-040).

---

### Edge Cases

- **A Todo leaves D while a scoped session is working it.** Only the operator can move it (the
  department field is operator-only, `packages/jinn/src/gateway/api.ts:2466`). The session's
  next call on that Todo returns 404. The turn finishes, and an `escalated` event is written
  on the Todo.
- **Scope changed while sessions are live.** Scope is read from the live roster on each
  request. A session bound to a department its employee has left, or that is no longer
  scoped, is refused everywhere except its own transcript, and `refuseTurn` starts no new turn
  in it.
- **Employee field and directory disagree.** If either names a non-open department, the org
  scan refuses the employee and logs why, as it does for a bad remote target
  (`packages/jinn/src/gateway/org.ts:112`). A refused employee cannot run.
- **Sub-tasks** share their root's department whenever either side is non-open. There is no
  re-parenting (`packages/jinn/src/gateway/api.ts:2192`).
- **Linking.** A scoped caller can link only D Todos, and sees any relation to a non-D Todo as
  a hidden count. Unscoped callers can link anything.
- **`department.yaml` broken or deleted.** The department keeps its last good scope, so a typo
  or a deleted file never opens a scoped department (FR-001).
- **Renaming a department.** Not supported today, and not added. Renaming the directory makes
  a new department. The old one keeps its Todos and its last good scope.
- **The `system` department** and the executive (the COO, who has no department) cannot be
  scoped. System employees follow FR-015 and never route a Todo to an employee who may not
  hold it.
- **The remote MCP connector** stays unscoped.
- **Connector-originated sessions** (Telegram) for a scoped employee are refused in v1.
- **Cron.** Validation refuses a cron job that targets a scoped employee.
- **Two employees on one profile.** Allowed. They share that account's limits, as everyone on
  the default profile does today.
- **A profile directory that does not exist.** The employee loads, and its turns are refused
  with the login hint (FR-054), as remote profiles are today
  (`packages/jinn/src/engines/remote-stage.ts:658`).

## Requirements *(mandatory)*

### Functional Requirements

**Departments as scopes**

- **FR-001**: A department's definition MUST be read from `org/<slug>/department.yaml`, where
  `<slug>` is the directory name. The file carries:
  - `name`, which must equal the directory name;
  - `displayName` and `description`;
  - `scope`: `open`, `scoped` or `dedicated`. An absent key means `open`, which is today's
    behaviour;
  - `workdirs`, `skills`, `sharedNotes` and `instructions` (data-model.md), used only when the
    scope is not `open`.

  The org scan reads it, and the existing `org/` watcher
  (`packages/jinn/src/gateway/watcher.ts:130`) already covers the file. The scan treats
  problems like this:

  - **Identity problems** refuse the file: YAML that does not parse, a `name` that does not
    match the directory, or an unknown `scope` value. The department keeps its **last good
    scope** (below), and the refusal is logged and shown on the department panel.
  - **Content problems** drop only the bad entry, with a logged warning: a missing skill, a
    `workdirs` entry that fails FR-033, or a bad `sharedNotes` path.
  - **Last good scope.** Every successful load records the department's scope in the registry
    (data-model.md, `department_scopes`). A department whose file is refused **or deleted**
    keeps its recorded scope. So a typo or a deleted file never turns a scoped department
    open. The operator opens a department only by writing `scope: open`.
  - **A refused file with no recorded scope** (a brand-new file that has never loaded): the
    department is treated as `dedicated` until the file loads, so its intended members are
    confined and nobody else can hold its Todos. The log line says so.
- **FR-002**: A Todo's department MUST remain `work_items.department`. No membership table is
  added and **no existing Todo is migrated**. "In D" means `department = D`, judged on the
  Todo's root (FR-004).
- **FR-003**: **Assignment never moves a Todo across a non-open boundary.** When a Todo's
  current department is not open, assignment keeps it, including assignment to `@operator`
  and to engine-only delegates. When a Todo is in an open department, assignment behaves as
  today. An assignment that would move a Todo into a non-open department is refused by
  FR-015 instead.
- **FR-004**: A sub-task MUST share its root's department when either department is not open.
  A create that names another department under such a root is refused. The board already shows
  sub-tasks under their root.
- **FR-005**: Scope comes only from `department.yaml`. A slug a writer names in open mode is an
  open department, as today. Unscoped callers may create Todos in a non-open department.
  Scoped callers create only in their own (FR-011).
- **FR-006**: `system` and the executive cannot be scoped. A `department.yaml` that sets a
  non-open scope on `system` is refused as an identity problem.

**Employee scope and session binding**

- **FR-007**: An employee MUST be scoped exactly when its resolved department is not open. No
  new employee field carries scope. The org scan refuses an employee whose `department` field
  and directory disagree when either is a non-open department. `PATCH
  /api/org/employees/:name` changing `department` into or out of a non-open department is
  subject to the stranding refusals in FR-015.
- **FR-008**: A session of a scoped employee MUST be bound to its department when it is
  created. A linked Todo outside that department refuses the spawn. The binding is stored on
  the session and never changes.
- **FR-009**: Only sessions of scoped employees carry a binding. An unscoped session's badge is
  derived at read time from its linked Todo. Scoped filters match only bindings, so an
  unscoped session is never visible to, or reachable from, a scoped one.

**Server-side enforcement** (applies to every request from a capability-bound session of a
scoped employee; D is that session's binding)

- **FR-010**: **Default deny.** Every gateway route not on the scoped-caller table in plan.md
  MUST be refused at the identified-caller gate (`packages/jinn/src/gateway/api.ts:1181`).
  WebSocket upgrades sit outside that gate, and not all of them are operator-only today
  (`packages/jinn/src/gateway/server.ts:1035`). The upgrade guard MUST refuse scoped callers
  on every upgrade path.
- **FR-011**: **Todos.**
  - Lists and searches are limited to D.
  - Per-Todo routes answer 404 for a Todo outside D, identical to the unknown-id response.
  - Creates land in D.
  - Changing a Todo's department is refused (it is operator-only already).
- **FR-012**: **Sessions.** Reads, searches, message context, `send_to_session` and
  `stop_session` are limited to sessions bound to D, except as FR-013 allows.
- **FR-013**: **Replying to a requester.** A scoped session MAY send to its own
  `parent_session_id` (`packages/jinn/src/gateway/spawn-session.ts:188`) with a live
  `send_to_session` (Q10-a). This grants no read access, and no other session can be reached
  this way.
- **FR-014**: **Org.**
  - Org reads return only D's members, and the prompt roster matches.
  - The department list returns only D.
  - Applying an existing label is allowed.
  - Label, sprint and department administration are refused.
- **FR-015**: **Who may hold a Todo.** `mayHoldTodo(employee, todoDepartment)` applies these
  rules:
  - A **scoped** employee holds only Todos in its own department.
  - An **unscoped** employee holds Todos in any department that is not `dedicated`.
  - A **`dedicated`** department's Todos are held only by its members.
  - `@operator` holds anything (`packages/jinn/src/gateway/todo-assignee.ts:21`).

  **Fallbacks**, so FR-035 holds:
  - with no scope resolver injected, everything passes;
  - a name that is not on the roster counts as unscoped;
  - a department's scope is its last good scope (FR-001), so a broken file never opens a
    department to everyone.

  **Where it is enforced**: in the work-items layer, at every SQL writer of `assignee`:
  - the `createWorkItem` insert (`packages/jinn/src/work-items/store.ts:356`);
  - the two dynamic update paths in `store.ts`, which are followed by `releaseOnOwnerChange` at
    `packages/jinn/src/work-items/store.ts:797` and `:850`;
  - `assignWorkItem`'s own `UPDATE` (`packages/jinn/src/work-items/assignment.ts:98`). It does
    not go through `releaseOnOwnerChange`. It serves `POST /:id/assign`, delegation onto an
    existing Todo (`packages/jinn/src/gateway/api.ts:3501`) and the talk adapters.

  The list comes from `git grep` over the SQL, not from a code comment, and T045 re-runs that
  enumeration. That covers:
  - `assignWorkItem`, PATCH and the talk adapters;
  - delegation's create-already-assigned path (`packages/jinn/src/gateway/api.ts:3450`);
  - plugin creates (`packages/jinn/src/plugins/host/todos.ts:31`);
  - cron creates (`packages/jinn/src/cron/runner.ts:101`).

  These paths are checked at their own entry instead: spawn with a linked Todo, Dispatcher
  routing, and the board-walk projection (which skips the Todo).

  **Stranding transitions are refused, and the refusal names the holders**: a Todo's
  department change, a scope change on a department, and an employee's department change.
  Violations made by hand-editing YAML are reported by the scan instead, and FR-008 refuses
  new sessions on the affected Todos.
- **FR-016**: **Spawning from a scoped caller.** `spawn_session`, `delegate_task` and
  `dispatch_work_item` may target only D's members. The child is bound to D.
- **FR-017**: **Company control plane.** Refused: config, cron, cost, connectors, global
  search, the skills API, and Notes and state outside the department.
- **FR-018**: **Local file reads on a scoped session's behalf.** `publish_attachment`,
  path-based `attach_to_work_item` and the JSON `{path}` attachment route accept only
  realpaths inside D's working directories or D's stage dir. `list_files` and `read_file` are
  refused. Unscoped callers are unchanged (Q6-b).
- **FR-019**: **Tool profile.** A scoped session's MCP manifest omits every tool whose routes
  are all refused. Unscoped manifests are unchanged.

**Scoped context** (what a scoped session's engine loads)

- **FR-020**: A scoped session MUST run with cwd set to a generated stage dir outside
  `$JINN_HOME`: `<parent of home>/.jinn-departments/<slug>/`. This is the only way to stop
  Claude Code loading the company `CLAUDE.md` (it reads from the cwd and its ancestors) and the
  company skills directory.
- **FR-026**: In v1 a scoped employee MUST use the `claude` engine and run locally. The stage
  dir uses Claude's layout (`CLAUDE.md`, `.claude/skills/`), and a remote session ignores the
  local cwd and runs in `remoteCwd`. Validation refuses another engine or a `remoteHost` on a
  scoped employee, and says why.
- **FR-027**: A department MAY carry a skill allow-list. A scoped session is offered only the
  allow-listed skills, through:
  - copies in the stage dir;
  - the prompt;
  - `dispatchConfig.skills` validation.

  An empty list means no skills.
- **FR-028**: Department Notes live under `knowledge/departments/<slug>/`, including the
  department's state file, `knowledge/departments/<slug>/state.md`.
  - **Seeding the state file.** It is created on the first note write, in the same format as
    the company `state.md`: a title, then sections of keyed bullets (`- key: value`).
  - **Rooting.** For a scoped caller, `search_knowledge`, `read_knowledge` and the note tools
    are rooted there, plus D's `sharedNotes`.
  - **Note tools always on for scoped sessions.** The scoped profile carries the note tools,
    and the note routes serve scoped callers, even when `gateway.notesEnabled` is off
    (`packages/jinn/src/gateway/api.ts:1207`). This is safe because they are rooted at the
    department folder.
  - **Session marker.** The gateway sets `JINN_DEPARTMENT` in a scoped session's environment.

  Excluded unless shared: the company `knowledge/state.md`, `knowledge/employees/`, `docs/`
  and every other company path.
- **FR-029**: `knowledge/departments/<slug>/INSTRUCTIONS.md` is written into the stage dir as
  `CLAUDE.md`. Appending the company `CLAUDE.md` is a per-department opt-in
  (`instructions: department+company`). The default is department only. The generated file
  always ends with a fixed paragraph saying that:
  - the session is scoped to D;
  - it uses the jinn tools for company state;
  - it does not read `$JINN_HOME`, other repos or other sessions' transcripts with its shell;
  - it keeps state in `knowledge/departments/<slug>/state.md` through the note tools.
- **FR-033**: **Working-directory validation.** A department working directory MUST:
  - be inside a git work tree whose top level is neither `$HOME` nor an ancestor of it;
  - not be, or be an ancestor of, `$HOME`, `$JINN_HOME`, the stage root, `~/.claude` or any
    employee's `claudeConfigDir`;
  - not lie inside `$JINN_HOME`, the stage root, `~/.claude`, any `claudeConfigDir`,
    `~/.ssh`, `~/.config`, `~/.aws`, `~/.gnupg` or `~/Library`.

  The scan and the department panel refuse a violating entry.

**Per-employee Claude profiles**

- **FR-050**: An employee MAY set `claudeConfigDir`: the Claude Code profile its **local**
  sessions run as. Absent means the gateway's own profile, as today.
  - It must be an absolute path, not starting with `~`, as `remoteClaudeConfigDir` is
    validated (`packages/jinn/src/shared/remote-target.ts:114`).
  - It must not lie inside `$JINN_HOME`.
  - It is refused on a remote employee, which uses `remoteClaudeConfigDir`. One field per
    target, so there is never a question of which applies.
  - It is YAML-only, like the remote fields (`WRITABLE_FIELDS`,
    `packages/jinn/src/gateway/org.ts:170`). The UI shows it read-only.
  - The file-read policy protects it as it protects the default profile
    (`packages/jinn/src/shared/file-read-policy.ts:64`), so attachment and file reads refuse
    its auth files.
- **FR-051**: **Environment.** Every local launch of a session with a named profile MUST set
  `CLAUDE_CONFIG_DIR` to it: the turn spawn, the idle PTY spawn, the redelivery respawn, the
  rate-limit retry, auto-compaction, and both forms of fork. A session without one gets
  exactly today's environment.
- **FR-052**: **Trust.** Before the first spawn under a named profile in a given cwd, the
  gateway MUST seed folder trust in that profile's `.claude.json`, cached per profile and cwd.
  Today's only seed is the boot-time one for the default profile
  (`packages/jinn/src/gateway/server.ts:565`). Without it, the trust dialog appears in front of
  an unattended PTY and the first turn hangs (the warning at
  `packages/jinn/src/shared/remote-target.ts:217`).
- **FR-053**: **Transcripts.** Every local transcript reader MUST resolve the session's
  profile: redelivery dedupe, lost-Stop and lost-text recovery, compaction stats, the
  transcript and backfill endpoints, external turns, and fork. research.md lists each one.
- **FR-054**: **Signed in.** Before a turn under a named profile, the gateway MUST check that
  the profile exists and holds a login:
  - on macOS, the Keychain entry `Claude Code-credentials-<suffix>` for that profile (fact 4),
    checked by existence only, without reading the secret;
  - elsewhere, `<profile>/.credentials.json`.

  If it fails, `refuseTurn` refuses with the profile path and the login command
  (`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`). Only successes are cached, as the remote
  check does (`packages/jinn/src/engines/remote-stage.ts:639`).
- **FR-055**: **Per-account state.** The auth outage ledger, engine health, the rate-limit
  memory and the limits snapshot MUST be keyed per profile. The default profile keeps today's
  keys, so nothing changes for it. A named profile gets its own key. One account's limit or
  outage never holds back another account's sessions, and the board walk reads the windows of
  the profile it is about to start.
- **FR-056**: **No cross-account fallback.** A session with a named profile MUST NOT be retried
  on another profile or on another engine. A rate limit makes it wait for its own reset.
  Fallback would move the work onto the operator's accounts.
- **FR-057**: **Model discovery stays on the default profile.** The model catalog and effort
  discovery read the operator's login, as today. A named profile uses the same model list.
- **FR-058**: **Remote profile fix.** `remoteClaudeConfigDir` MUST reach the session on every
  remote launch path, including ordinary turns (`engine-run.ts:55`) and the rate-limit turn
  (`rate-limit-turn.ts:166`), which drop it today.
- **FR-059**: **Profiles and scope.** Unscoped employees MAY use a named profile, for example
  the operator's own second account. A scoped employee's named profile is refused until it
  runs from a stage dir (FR-020). If Phase 4 merges before Phase 3, that refusal is what keeps
  the company `CLAUDE.md` and skills off another account.

**Compatibility**

- **FR-035**: Unscoped employees, open departments and employees without a named profile MUST
  behave as they do today:
  - every existing route, tool and engine launch does what it does on `main`;
  - wire changes are limited to additive, nullable fields;
  - the core MCP manifest is unchanged, checked by the attested hash in
    `tool-manifest-budget.test.ts`;
  - with no `department.yaml` setting a scope, nothing is scoped and nothing is logged.
- **FR-036**: The core MCP manifest MUST NOT grow. Scoped callers get their department from
  the binding.

**UI and verification**

- **FR-040**: These elements MUST be captured in light and dark, with screenshots on the PR:
  - the scope badge on the board switcher and on the org tree's department group;
  - the department panel;
  - the profile badge on the org tree and the read-only profile row in the employee panel;
  - the session badges;
  - the "not signed in" refusal as shown in chat.
- **FR-041**: The org tree MUST show each department's scope, and each employee's named
  profile, as badges. Open departments and the default profile show no badge.
- **FR-042**: The UI MAY edit a department's definition. When it does:
  - it writes `department.yaml`, as `PATCH /api/org/employees/:name` writes the employee's
    YAML today;
  - each write is atomic: a temp file in the same directory, then a rename;
  - the in-memory definitions are refreshed before the response returns;
  - a scope change runs the FR-015 stranding check.

  Hand-edited YAML stays the source of truth. The UI never holds state the files do not.

### Deferred to future sandbox work (withdrawn from this feature by Q1 = A)

These items belong to the operator's separate sandboxing work and are not built here.
research.md keeps the findings, so that work does not start from zero.

- An allow-listed engine environment without `JINN_GATEWAY_TOKEN`, plus secret references by
  name.
- Default-deny reads under `$HOME`, plus blocking process inspection.
- `--strict-mcp-config` and connector exclusion.
- Stopping capability derivation.
- Making `authRequired` a precondition, hardening the exempt routes, and carrying the hook
  relay's context on argv.
- The escape script.
- A separate OS user.
- Scoped employees on remote targets (FR-026).

### Key Entities

- **Department definition** (`org/<slug>/department.yaml`): name, display name, description,
  scope, working directories, skill allow-list, shared Notes, instructions mode.
- **Department scope record** (registry): the last good scope of each department.
- **Employee department** (existing): one per employee. It decides whether the employee is
  scoped.
- **Session department binding** (registry): present only on sessions of scoped employees, and
  fixed at creation.
- **Department stage directory**: a generated cwd for each non-open department, outside
  `$JINN_HOME`.
- **Employee Claude profile** (employee YAML, `claudeConfigDir`): the profile its local
  sessions run as.

## Success Criteria *(mandatory)*

- **SC-001**: Every row of the scoped-caller table has an allow test and a refuse test against
  the real API handler. A route-enumeration test fails on any route that is not classified.
- **SC-002**: Unscoped behaviour is unchanged:
  - the existing suite passes;
  - the manifest hash test is untouched;
  - a one-off comparison of `buildContext` output and engine argv and environment between
    `main` and the branch, for a fixed unscoped roster without profiles, is recorded as PR
    evidence. It is not committed as a fixture.
- **SC-003**: For an employee with a named profile, a test asserts `CLAUDE_CONFIG_DIR` on every
  launch path in FR-051, and a test per FR-053 reader finds a transcript under the profile.
- **SC-004**: The token counts in `tool-manifest-budget.test.ts` do not rise.
- **SC-005**: Every FR-040 element has light and dark screenshots on the PR.
- **SC-006**: Two profiles with independent limits: marking one rate-limited leaves sessions on
  the other startable, and the reverse.

## Assumptions

- Single operator, single machine, single OS user. Scoping is a gateway guardrail, not an OS
  boundary (see "Scope of the boundary").
- The operator signs each profile in by hand, once. The gateway never runs `/login`.
- Concurrent employees in one department share its working directories. Worktrees remain the
  answer.
- Personas do not vary per department. A different role means a separate employee.
- An employee belongs to one department, so a scoped employee works in exactly one scope.
  Grouping company work by client inside one department is not part of this feature; labels and
  sprints already exist for that.
- Cron stays company-level in v1.
