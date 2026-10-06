# Feature Specification: Department-Scoped Employees and Per-Employee Claude Profiles

**Feature Branch**: `feat/project-scoping-spec`

**Created**: 2026-10-05. **Revised**: 2026-10-06, when the operator replaced projects with
departments, brought per-employee local Claude profiles into scope, separated profiles from
scope, and asked for scoped employees on remote hosts (D1 to D5).

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
| D4 | **A Claude profile is a per-employee path and nothing more.** It is independent of department scope. The operator owns every profile, and the system does not track who a profile belongs to | FR-059: no owner marker, and no rule tying a profile to a scope or a phase |
| D5 | **Scoped employees run locally or on a remote host.** The system must not assume this Mac | FR-026 and FR-060 to FR-066 (Phase 5). The earlier local-only rule is withdrawn |
| D6 | **The Limits screen and auto-dispatch must handle several Claude accounts.** Raised by the operator | FR-070 to FR-078 (Phase 6). Limits and dispatch are judged **per account**, not per department, because a profile is independent of department (D4). An operator who gives each department its own account gets per-department dispatch from the same rule |
| D7 | **Docs, instance migration and visual testing are part of every phase** | FR-043 to FR-045 |
| D8 | **Remote accounts report their usage back to the gateway** | FR-072: live readings for remote accounts |
| D9 | **No custom fallback for the board walk.** Use the existing routing fallbacks (`engines.<engine>.fallback`), and let **each Claude account have its own fallback chain**, as if each were its own Claude installation | FR-076 decided: a walk turn keeps today's behaviour. FR-056 and FR-079: per-account chains on the existing mechanism |

**One choice this spec makes that the operator may override (FR-075a).** An account with no
live reading gets at most one probing start, which produces a reading.

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
  What follows the **Claude profile** rather than the cwd still loads: the profile's own
  user-level skills and plugins, and the claude.ai connectors of that account. On the default
  profile those are the operator's (for example Slack, Gmail, Drive and Jira). Excluding them
  is part of the deferred connector work.
- **It keeps the docs honest.** Scoped employees are described as "kept in scope by the
  gateway", not "cannot reach".

**What goes to another account.** Every prompt, tool output and file read in a session on a
named Claude profile goes to that profile's account. Which profile an employee uses is the
operator's choice, made in its YAML, and the gateway applies it as written (D4). It does not
tie profiles to departments, and it does not ask whose account a profile is. What a session
sends follows from its scope: an unscoped session loads the company `CLAUDE.md`, every skill
and `state.md`, and so does a scoped one until Phase 3 has merged. The docs (T078) say so
beside the profile field.

**Remote hosts.** A remote session runs over SSH with the gateway's home mounted on the remote
host (`packages/jinn/src/shared/config-types.ts:274`). A scoped remote session is held to the
same guardrail as a local one (FR-060 to FR-066). Its shell can still reach that mount, just
as a local scoped session's shell can reach `$JINN_HOME`.

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
     (`packages/jinn/src/shared/types.ts:182`). Even that is dropped on ordinary turns and on
     auto-compaction: `engine-run.ts:55` passes the remote host, user and cwd but not the
     profile, so those turns fall back to the instance default. The rate-limit path rebuilds
     the target from the employee (`sessions/rate-limit-handler.ts:104`), so it keeps it.
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
6. **Given** an unscoped employee with `claudeConfigDir` set, **When** it runs, **Then** it
   runs on that profile with no further marker or check (FR-059).

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

### User Story 5a: A scoped employee runs on a remote host (Priority: P2)

The operator gives `side-dev` a `remoteHost` and a `remoteCwd` under `remote.root`, and leaves
it in scoped department D. Its sessions run on that host, held to the same scope as a local
scoped session.

**Acceptance Scenarios**:

1. **Given** `side-dev` is remote and scoped, **When** it starts, **Then** its cwd is
   `<remote.root>/.jinn-departments/side-project/`, holding exactly the allowed skills and the
   generated `CLAUDE.md` (FR-060, FR-061).
2. **Given** the same session, **Then** its `$JINN_HOME` has no links into the company home,
   and no company `CLAUDE.md` is linked into any directory for it (FR-062).
3. **Given** the operator edits D's `INSTRUCTIONS.md`, or a session edited the remote stage
   dir, **When** `side-dev` next starts on that host, **Then** the remote stage dir holds the
   generated `CLAUDE.md`, and its path and inode are unchanged (FR-020a, FR-060).
4. **Given** `side-dev` calls a jinn tool, **Then** the gateway applies D's scope exactly as for
   a local scoped session (FR-064).
5. **Given** an unscoped remote employee, **Then** its staging is unchanged from `main`.

**Independent Test**: the remote staging for a scoped session, recorded as the SSH scripts it
runs, has the stage dir as cwd and no farm links. The farm script variant runs under `sh`
against temporary directories standing in for the mount and the remote root.

---

### User Story 5b: Several Claude accounts on the Limits page and in auto-dispatch (Priority: P1)

The operator runs `side-dev` on the friend's account and everyone else on their own.

**Acceptance Scenarios**:

1. **Given** two local Claude accounts, **When** the operator opens Limits, **Then** there
   are two Claude cards, each with its own windows, plan and employees (FR-073).
2. **Given** the operator's account is near its weekly ceiling and the friend's is about to
   lapse unused, **When** the board walk ticks, **Then** it may start a ready D Todo
   assigned to `side-dev`, and starts nothing on the operator's account (FR-075). If the
   friend's account has no live reading, it gets one probing start (FR-075a).
5. **Given** `engines.claude.accounts.friend.fallback: []` and `engines.claude.fallback:
   [codex]`, **When** `side-dev` is rate-limited, **Then** it waits for the friend's reset,
   while an operator-account session in the same state moves to codex (FR-079).
6. **Given** a remote employee on its host's default login, **When** the operator opens
   Limits, **Then** that account has its own card with live windows, read over SSH (FR-072).
3. **Given** the friend's account is recorded exhausted, **When** the walk tries to start a
   Todo assigned to `side-dev`, **Then** the start is refused in code, and work on the
   operator's account is unaffected (FR-075).
4. **Given** only the default account, **Then** Limits, the usage card and the walk behave
   exactly as on `main` (FR-078).

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
  or a deleted file never opens a scoped department (FR-001). The last good scope lives in the
  registry, so a registry restored from an older backup or rebuilt from scratch, together with
  a deleted file, does open it. A file that has never loaded and has no `scope` key, or `scope: open`
  (for example an old file with an unquoted colon), leaves its department open; one with any
  other `scope` value, a typo included, is held dedicated. A near-miss file name in a department directory, such as
  `department.yml`, is logged as a warning.
- **Renaming a department.** Not supported today, and not added. Renaming the directory makes
  a new department. The old one keeps its Todos and its last good scope.
- **The `system` and `org` departments** and the executive (the COO, who has no department) cannot be
  scoped. System employees follow FR-015 and never route a Todo to an employee who may not
  hold it.
- **The remote MCP connector** stays unscoped.
- **Connector-originated sessions** (Telegram) for a scoped employee are refused in v1.
- **Cron.** Validation refuses a cron job that targets a scoped employee.
- **Two employees on one profile.** Allowed. They share that account's limits, as everyone on
  the default profile does today.
- **A remote host that is asleep or unreachable.** A scoped remote session waits or is refused
  exactly as an unscoped one is today (`ensureRemoteReady`). The stage dir is pushed once the
  host answers.
- **A scoped department used from several hosts.** Each host gets its own copy of the stage
  dir, pushed on first use and on change.
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
  - **A refused file with no recorded scope** (a file that has never loaded): the department
    is treated as `dedicated` until the file loads **only if the file's raw text has a
    `scope:` key whose value is anything other than `open`**, meaning a line that matches
    `^[ \t]*scope[ \t]*:[ \t]*(?!["']?open["']?[ \t]*(#.*)?$)\S` (multiline,
    case-insensitive). So a file that asks for confinement, or that mistypes the scope
    (`scope: scopd`), fails closed: its intended members are confined and nobody else can
    hold its Todos. A file with no `scope` key, or with `scope: open`, leaves the department
    `open`, which is today's behaviour: earlier templates described a `department.yaml` that
    nothing read and never carried a `scope`, so an instance may hold one the parser refuses,
    and an upgrade must not confine or drop anyone. Either way the refusal is logged and shown
    on the department panel, and the log line says which.
- **FR-002**: A Todo's department MUST remain `work_items.department`. No membership table is
  added and **no existing Todo is migrated**. **A Todo's scope department is its root's
  department.** Every scope decision in this spec (FR-003, FR-011, FR-015, the route table and
  the board) reads the root's department, never a sub-task's own column. A sub-task whose own
  column differs from its root's (possible today, `packages/jinn/src/work-items/store.ts:329`)
  is in its root's scope. The department registry, which reads the work-items registry, reports
  it at scan time.
- **FR-003**: **Assignment never moves a Todo across a non-open boundary.** When the root's
  department is not open, assignment leaves the Todo's department unchanged, including
  assignment to `@operator` and to engine-only delegates. When the root's department is open,
  assignment behaves as today. An assignment that would move a Todo into a non-open department
  is refused by FR-015 instead.
- **FR-004**: A sub-task MUST share its root's department when either department is not open.
  A create that names another department under such a root is refused. The check lives in
  `createWorkItem` in the store, not only in the route, because plugin creates pass a draft
  straight through (`packages/jinn/src/plugins/host/todos.ts:31`). The board already shows
  sub-tasks under their root.
- **FR-005**: Scope comes only from `department.yaml`. A slug a writer names in open mode is an
  open department, as today. Unscoped callers may create Todos in a non-open department.
  Scoped callers create only in their own (FR-011).
- **FR-006**: `system`, `org` and the executive cannot be scoped. A `department.yaml` that sets
  a non-open scope on `system` is refused as an identity problem. An employee YAML at the top of
  `org/` resolves to the department `org` today (`packages/jinn/src/gateway/org.ts:81`); it
  stays unscoped.

**Employee scope and session binding**

- **FR-007**: An employee MUST be scoped exactly when its resolved department is not open. No
  new employee field carries scope. **Scope is read from the top-level directory under
  `org/`**, not from the immediate parent: the org walker recurses, and today
  `org/side-project/qa/side-qa.yaml` resolves to department `qa`
  (`packages/jinn/src/gateway/org.ts:81`). The org scan refuses an employee when its top-level
  directory, its immediate directory or its `department` field disagree and any of them is a
  non-open department. `PATCH
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
  - The two MCP tools read the file themselves, in the session's jinn MCP server, and upload
    the bytes (`packages/jinn/src/mcp/file-tools.ts:98`,
    `packages/jinn/src/mcp/work-item-attachments.ts:103`). They never use the JSON `{path}`
    route. So the check runs **in each tool**, with the allowed roots taken from the scoped
    session's MCP config. The gate checks only the JSON `{path}` route.
- **FR-019**: **Tool profile.** A scoped session's MCP manifest omits every tool whose routes
  are all refused. Unscoped manifests are unchanged.

**Scoped context** (what a scoped session's engine loads)

- **FR-020**: A scoped session MUST run with cwd set to a generated stage dir outside
  `$JINN_HOME`: `<parent of home>/.jinn-departments/<slug>/`. This is the only way to stop
  Claude Code loading the company `CLAUDE.md` (it reads from the cwd and its ancestors) and the
  company skills directory.
- **FR-020a**: **Stage dir updates.** The stage dir's path and the directory itself MUST stay
  stable. It is never replaced or renamed, because the transcript slug (resume, fork and
  auto-compaction) and the trust key (`trustSeedKey`,
  `packages/jinn/src/engines/remote-stage.ts:912`) both derive from the cwd. An update
  **syncs** it to the generated file set:
  - the new file set is written to an incoming directory beside the stage dir, on the same
    filesystem (`.jinn-departments/.<slug>.incoming-<random>/`);
  - the sync works **file by file**. Only files are renamed: each file whose content differs is
    renamed over the old one, which is atomic. Directories are created with `mkdir -p` and are
    never renamed over an existing directory (a skill is a directory, and that rename fails on
    a non-empty target). A whole skill directory is moved in only when nothing exists at its
    target yet;
  - a path that changes type (file to directory, or the reverse) is removed first;
  - extras are then removed: any file or directory not in the set, **including a file that
    disappeared from inside a skill still on the list**, as well as whole dropped skills;
  - the incoming directory is deleted. Each sync also removes incoming directories older than
    an hour, left by a sync that died, as the farm script reaps old session stages;
  - unchanged files are not touched.

  The generator refuses a skill that contains a symlink and logs why, so no link to a gateway
  path is copied or shipped to a remote host.

  **What a running session sees during a sync:** each file is either wholly old or wholly new.
  For a moment it can see a mix of old and new files, and a dropped skill disappears at the
  end. Its cwd never disappears.

  The sync runs on the Phase 3 triggers and **before every scoped spawn**, so an edit a
  session made to its stage dir is reverted when the next scoped session starts. Between
  spawns a session can still edit it; this is a guardrail. No hash cache is kept, so there is
  no cache to outlive the directory. Local and remote stage dirs follow this rule identically.
- **FR-020b**: **Every local spawn of a scoped session uses the stage dir.** Today four local
  session-spawn sites hard-code `cwd: JINN_HOME`:
  - `packages/jinn/src/sessions/turn/engine-run.ts:46`: turns, and auto-compaction through it;
  - `packages/jinn/src/sessions/rate-limit-handler.ts:185`: the substitute (Branch A);
  - `packages/jinn/src/sessions/rate-limit-handler.ts:301`: the wait-and-retry (Branch B), which
    resumes the engine session from that cwd;
  - `packages/jinn/src/gateway/pty-ws.ts:139`: the terminal attach.

  All four MUST take the cwd from one helper (session or employee to cwd), the local twin of
  FR-061, so a scoped session never retries or attaches in `$JINN_HOME`. A grep test fails on
  any `cwd: JINN_HOME` at a session-spawn site outside an allow-list. The allow-list covers the
  ssh process's own local cwd (`packages/jinn/src/engines/claude-interactive.ts:3102`, `:3240`)
  and engines a scoped employee cannot use (opencode, pi).
- **FR-026a**: **No engine substitute for a scoped session.** Another engine cannot use the stage
  dir's Claude layout, and in `$JINN_HOME` it would read the company `AGENTS.md`. So a scoped
  session MUST skip engine entries in any fallback chain, its account's own (FR-079) or
  `engines.claude.fallback`, and accept only Claude-account entries. With none left, it waits
  for its reset. Until Phase 6, a scoped session skips engine fallback entirely. This applies
  to remote scoped sessions too, and takes precedence over FR-056's remote inheritance.
- **FR-026**: In v1 a scoped employee MUST use the `claude` engine, because the stage dir uses
  Claude's layout (`CLAUDE.md`, `.claude/skills/`). It MAY run locally or on a remote host
  (D5). Validation refuses another engine and says why. A scoped employee with a `remoteHost`
  is refused until Phase 5 has merged, because before then its session would run in
  `remoteCwd` with the company home linked in. The refusal names the reason.
- **FR-027**: A department MAY carry a skill allow-list. Of the company skills, a scoped
  session is offered only the allow-listed ones, through:
  - copies in the stage dir;
  - the prompt;
  - `dispatchConfig.skills` validation.

  An empty list means no company skills. Skills and plugins installed in the session's Claude
  profile still load ("Scope of the boundary").
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
  - It is canonicalised once, at load: no trailing slash, no `.` or `..` segments. That exact
    string is what the session gets as `CLAUDE_CONFIG_DIR`, what the Keychain name is hashed
    from, and what the login hint prints. Claude Code hashes the raw string, so two spellings
    of one directory are two logins.
  - It must not lie inside `$JINN_HOME`, and must not equal the default profile's directory:
    naming the default explicitly gives a suffixed Keychain entry, not the operator's login.
  - It is refused on a remote employee, which uses `remoteClaudeConfigDir`. One field per
    target, so there is never a question of which applies.
  - It is YAML-only, like the remote fields (`WRITABLE_FIELDS`,
    `packages/jinn/src/gateway/org.ts:170`). The UI shows it read-only.
  - The file-read policy protects it as it protects the default profile
    (`packages/jinn/src/shared/file-read-policy.ts:64`), so attachment and file reads refuse
    its auth files.
- **FR-051**: **Environment.** Every local launch of a session with a named profile MUST set
  `CLAUDE_CONFIG_DIR` to it: the turn spawn, the idle PTY spawn, the redelivery respawn, the
  rate-limit retry, auto-compaction, and both forms of fork. It MUST also remove any inherited
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which would otherwise override the Keychain name. A
  session without a named profile gets exactly today's environment.
- **FR-052**: **Trust.** Before the first spawn under a named profile in a given cwd, the
  gateway MUST seed folder trust in that profile's `.claude.json`, cached per profile and cwd.
  Today's only seed is the boot-time one for the default profile
  (`packages/jinn/src/gateway/server.ts:565`). Without it, the trust dialog appears in front of
  an unattended PTY and the first turn hangs (the warning at
  `packages/jinn/src/shared/remote-target.ts:217`).
- **FR-052a**: **Operator settings travel with the session.** A named profile does not read the
  operator's `~/.claude/settings.json`, and today the gateway relies on three of its keys
  without carrying them itself:
  - `attribution` (empty commit and PR attribution, no session URL), which keeps
    Co-Authored-By trailers and "Generated with" lines out of commits and PRs;
  - `hooks.PreToolUse`, which on this instance carries the Slack read-only guard;
  - `skipDangerousModePermissionPrompt`, without which the bypass-permissions consent dialog
    appears in front of an unattended PTY.

  For a named profile only, the gateway MUST copy these three keys from the default profile's
  `settings.json` into the session's `--settings` file
  (`packages/jinn/src/shared/claude-settings.ts:70`), merging `hooks` with the gateway's own.
  Each key gets a test. Sessions on the default profile are unchanged.

  A unit test only proves the file holds the keys. Claude Code may read some of them only from
  user or policy settings, not from `--settings`: the installed binary reads
  `skipDangerousModePermissionPrompt` from user and policy settings in at least one place. So
  Phase 4 verifies each key end to end in a real session (T073a). **Fallback:** a key that is not
  honoured from `--settings` is written into `<profile>/settings.json` instead, and the FR-054
  check also requires it to be there.
- **FR-053**: **Transcripts.** Every local transcript reader MUST resolve the session's
  profile: redelivery dedupe, lost-Stop and lost-text recovery, compaction stats, the
  transcript and backfill endpoints, external turns, and fork. research.md lists each one.
- **FR-054**: **Signed in.** Before a turn under a named profile, the gateway MUST check that
  the profile exists and holds a login:
  - on macOS, the Keychain entry `Claude Code-credentials-<suffix>` for that profile (fact 4),
    checked by existence only, without reading the secret;
  - elsewhere, `<profile>/.credentials.json`.

  If it fails, `refuseTurn` refuses with the profile path and the login command
  (`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`), printing the canonical string from
  FR-050 exactly. Only successes are cached, as the remote
  check does (`packages/jinn/src/engines/remote-stage.ts:639`).
- **FR-055**: **Per-account state.** The auth outage ledger, engine health and the rate-limit
  memory MUST be keyed per account (FR-070). The default profile keeps today's keys, so nothing
  changes for it. A named profile gets its own key. One account's limit or outage never holds
  back another account's sessions.

  **The default reading stays the default account's.** Every local session writes its
  status-line snapshot into one directory, and the default reading takes the newest file
  there, whoever wrote it (`packages/jinn/src/shared/engine-limits-claude.ts:239`,
  `packages/jinn/src/shared/engine-reset-times.ts:37`). So from Phase 4 on, every reader of
  that directory MUST take only snapshots written by default-account sessions (session to
  employee to account): the Limits card, the backoff reset time, the usage history and the
  board walk's reading. Otherwise a friend's session would show as the operator's windows,
  and the walk could start work on the operator's account because the friend's allowance is
  about to lapse. Phase 6 adds the readings of the other accounts (FR-071 to FR-077).
- **FR-056**: **Each account has its own fallback chain** (D9). A session on a **local** named
  profile MUST NOT inherit the default account's `engines.claude.fallback`, because that chain
  was written for the operator's account. Until Phase 6 gives accounts their own chains
  (FR-079), such a session has none: a rate limit makes it wait for its own reset. Remote
  employees, `remoteClaudeConfigDir` included, keep exactly today's behaviour: they inherit the
  engine chain, limited to engines that can run on their host.
- **FR-057**: **Non-session reads stay on the default profile.** These run outside any session
  and keep reading the operator's login:
  - the model catalog and effort discovery (`packages/jinn/src/shared/claude-models.ts:262`,
    and its credentials-file fallback at `:304`);
  - the Telegram connector's auth providers (`packages/jinn/src/connectors/telegram/auth-providers.ts:60`).

  A named profile uses the same model list. Its plan and limits are read per account in
  Phase 6 (FR-071).
- **FR-058**: **Remote profile fix.** `remoteClaudeConfigDir` MUST reach the session on every
  remote launch path. Ordinary turns and auto-compaction drop it today, because
  `engine-run.ts:55` does not pass it. The rate-limit path already rebuilds it from the
  employee (`sessions/rate-limit-handler.ts:104`); `rate-limit-turn.ts:166` passes it too, for
  consistency.
- **FR-059**: **Profiles are independent of scope (D4).** Any employee, scoped or not, MAY name
  a profile, and the gateway applies it as written. There is no owner field, no check of whose
  account a profile is, and no ordering between the profile work and the scope work: Phase 4
  does not wait for Phase 3. Two employees, scoped or not, may share a profile (Edge Cases).

**Scoped employees on remote hosts** (D5, Phase 5)

A remote session today runs in the employee's `remoteCwd`. Its `$JINN_HOME` is a symlink farm
over the gateway's home, which is mounted on the remote host, and the company `CLAUDE.md` is
linked into its cwd (`packages/jinn/src/engines/remote-stage.ts:966`, the farm script). For a
scoped employee each of those would undo FR-020, FR-027 and FR-028, so a scoped remote session
is staged differently. Unscoped remote sessions are unchanged.

- **FR-060**: **Remote stage dir.** For each remote host a scoped member uses, the gateway MUST
  keep a copy of D's stage dir at `<remote.root>/.jinn-departments/<slug>/` on that host.
  - Its content is exactly the local stage dir's: the same generator (Phase 3) produces it.
  - It is synced by FR-020a before **every** scoped spawn on that host. The file set travels
    as a tar stream over SSH into the incoming directory, and a sync script applies it. With
    no cache, a wiped or edited remote stage dir is restored on the next spawn.
  - Syncs run inside the existing per-host serialisation
    (`packages/jinn/src/engines/remote-stage.ts:792`), **before the trust seed**. The seed runs
    `mkdir -p <cwd>` (`packages/jinn/src/engines/remote-stage.ts:936`), so seeding first would
    create an empty stage dir.
  - It sits under `remote.root`, so it stays inside the existing remote guardrail
    (`packages/jinn/src/shared/config-types.ts:268`).
- **FR-061**: **Remote cwd.** A scoped remote session MUST run with its cwd set to the remote
  stage dir, not the employee's `remoteCwd`.
  - **One helper.** The override lives in `employeeRemoteTarget`
    (`packages/jinn/src/shared/remote-target.ts:207`), which gains the scope resolver as a
    **required** argument. A required argument only catches existing callers, so three sites
    that read `employee.remoteCwd` themselves move onto the helper by hand:
    - the inline target in `sessions/turn/engine-run.ts:55`;
    - the inline target in the rate-limit handler (`sessions/rate-limit-handler.ts:104`). Its
      `?? remoteCwd` fallback to the original run's value fails closed for a scoped session
      with no employee record: the retry is refused;
    - `sessions/turn/rate-limit-turn.ts:168`, which stops passing a raw `remoteCwd`.

    A grep-based test, like the route-enumeration test, fails if anything outside
    `shared/remote-target.ts` reads an employee's `remoteCwd` to build a target. It matches
    reads off an employee record only, so display structs such as `cli/remote.ts`'s own
    `remoteCwd` field do not trip it. The callers
    are then:
    - `sessions/turn/engine-run.ts`: turns, and auto-compaction through it;
    - `sessions/turn/rate-limit-turn.ts` and the rate-limit handler: the retry;
    - `gateway/pty-ws.ts:134`: the terminal attach;
    - `sessions/turn/remote-ready.ts:76`: wake, mount and profile readiness before a turn. It
      uses the host, not the cwd;
    - `gateway/session-file-read.ts:67`: the operator's chat file links. Relative links
      resolve against the stage dir, which is the session's real cwd. Absolute links work as
      today;
    - `cli/remote.ts:58`: `jinn remote` status, which shows both the stage dir and the work
      area for a scoped employee.

    Fork has no remote path today.
  - The employee's `remoteCwd` stays its work area. The session's prompt names it, because the
    stage dir is shared by the whole department and cannot. FR-065 uses it.
  - **Validation at load** (`gateway/org.ts`): a scoped employee's `remoteCwd` must not be,
    contain or lie inside `<remote.root>/.jinn-departments` or `remote.mount`. Nothing today
    stops the mount sitting under `remote.root`
    (`packages/jinn/src/shared/remote-target.ts:156`), and a work area over the mount would make
    the whole company home an FR-065 root.
  - **Validation at spawn** (`prepareRemoteSession`): the per-host stage root
    (`$HOME/<REMOTE_STAGE_DIR>`, `packages/jinn/src/engines/remote-stage.ts:418`) holds every
    session's `gateway.json` and bearer token, and is known only from the host's facts. A
    scoped spawn whose `remoteCwd` is, contains or lies inside it is refused. The check fails
    closed: if the facts are missing, the spawn is refused.
- **FR-062**: **No company home on the remote host.** A scoped remote session's `$JINN_HOME`
  MUST hold only what reaches the gateway: `gateway.json`, `tmp/` (settings, MCP config and the
  environment file) and the stage marker. The farm links to the company home are not made, and
  the company `CLAUDE.md` is not linked into any cwd. The scoped variant of the farm script
  keeps the rest:
  - reaping old session stages;
  - the per-session lock;
  - the `asset=` report (`packages/jinn/src/engines/remote-stage.ts:1086`), which
    `ensureAssets` reads, so a wiped per-host stage still restages itself.
- **FR-063**: **Trust.** The gateway MUST seed folder trust for the remote stage dir under the
  session's profile, with the existing remote seed (`seedRemoteTrust`, keyed by host, profile
  and cwd).
- **FR-064**: **Binding and marker.** A scoped remote session is bound to D in `spawnSession`
  exactly as a local one is (FR-008), and the remote environment file carries
  `JINN_DEPARTMENT=<slug>`. The gateway's scope checks (FR-010 to FR-019) do not depend on where
  the session runs.
- **FR-065**: **File reads on the remote host.** For a scoped remote session, the FR-018 check
  runs in the same two tools, `publish_attachment` (`packages/jinn/src/mcp/file-tools.ts:98`)
  and path-based `attach_to_work_item` (`uploadWorkItemAttachment`,
  `packages/jinn/src/mcp/work-item-attachments.ts:103`). Both run in the session's jinn MCP
  server on the remote host. The allowed roots come from its staged MCP config: the employee's
  `remoteCwd` and the remote stage dir. Each tool has a test. The gateway's JSON `{path}`
  attachment route refuses a remote scoped session, because the path names a file on another
  machine.
- **FR-066**: **Profiles on remote hosts.** A scoped remote employee uses
  `remoteClaudeConfigDir`, or `remote.claudeConfigDir`, as every remote employee does, with the
  FR-058 fix. No new field is added.

**Limits and auto-dispatch per account** (D6, Phase 6)

Today the Limits page (`packages/web/src/routes/limits/page.tsx:232`) shows one card per
engine, and the gateway reads one Claude account for it
(`packages/jinn/src/shared/engine-limits-claude.ts:233`). The board walk measures "the Claude
allowance" as one pool. Its thresholds are prose in the operator's `board-walk.md`, and its
code gates are global (`packages/jinn/src/board-walk/route-turn.ts:85`,
`packages/jinn/src/board-walk/snapshot.ts:224`). research.md ("Limits and the board walk")
lists the ten places that assume one account.

- **FR-070**: **Accounts.** An account is an engine plus the login it runs as:
  - `claude`: the default profile, exactly as today;
  - `claude:<profile key>`: a local named profile (FR-050). It is labelled by its directory
    name, for example `.claude-friend`;
  - `claude@<user>@<host>`, or `claude@<user>@<host>:<profile key>` for a named profile: a
    remote login. The user is part of it, because two users on one host are two logins. With
    no `remoteUser` the key is `claude@<host>`. The auth outage ledger keeps its existing
    remote scope strings (`claudeAuthScope`,
    `packages/jinn/src/sessions/claude-auth-watch.ts:50`), and the helper maps an account to
    that scope, so no ledger entry is migrated;
  - every other engine keeps one account, its engine name. The shape allows more later.

  Each employee's account is derived from its engine, `remoteHost` and profile settings. One
  helper, beside `shared/claude-profile.ts`, computes it, and every per-account store uses it.
  Departments play no part: two departments sharing an account share its limits.
- **FR-071**: **Reading each local account.** For every local Claude account, the gateway MUST
  read live limits the way it reads the default one today:
  - the OAuth usage API, with that account's own token: the Keychain entry
    `Claude Code-credentials-<key>` on macOS, or `<profile>/.credentials.json` elsewhere. The
    token is used only in-process for that call. It is never logged, written to disk, put in a
    child environment or sent anywhere else. The signed-in check (FR-054) stays existence-only.
    A named account's read MUST skip `$CLAUDE_CODE_OAUTH_TOKEN`, which the reader checks first
    (`packages/jinn/src/shared/claude-models.ts:290`); otherwise every named account would show
    the default account's usage whenever that variable is set;
  - **no token refresh.** The gateway MUST NOT refresh a token itself. Refreshing rotates the
    refresh token underneath Claude Code. An expired access token
    (`packages/jinn/src/shared/claude-models.ts:244`) means no live reading until a session on
    that account refreshes it;
  - the plan, from `claude auth status` run with `CLAUDE_CONFIG_DIR` set to the profile;
  - the status-line snapshots, filtered to sessions on that account, as the fallback;
  - the reset time used by the rate-limit backoff
    (`packages/jinn/src/shared/engine-reset-times.ts:55`) and the usage history
    (`packages/jinn/src/shared/claude-usage-history.ts:44`), each per account. The default
    account keeps today's files.
- **FR-072**: **Remote accounts report their usage** (D8). Remote sessions write no status line
  to the gateway today (`packages/jinn/src/engines/remote-stage.ts:1378`), so the gateway MUST
  read each remote account itself, on the same refresh as the local ones:
  - **The token.** Over SSH, from the account's `.credentials.json`: the
    `remoteClaudeConfigDir` (or `remote.claudeConfigDir`), or `~/.claude` when neither is set.
    That is the file the existing remote sign-in check looks for
    (`packages/jinn/src/engines/remote-stage.ts:665`). **Only the access token and its expiry
    leave the host:** a small script run with the host's own Node (`facts.nodeBin`) parses the
    file there and prints those two fields, so the refresh token never crosses the network. The
    path is passed quoted, not interpolated. The access token is held in memory for the one
    usage call. It is never stored, so it cannot go stale when Claude Code rotates it, and it
    is never refreshed (FR-071).
  - **A macOS remote host** keeps its login in its Keychain. The same script reads it there with
    `security find-generic-password -w` under the service name Claude Code uses for that path:
    `Claude Code-credentials`, plus `-<first 8 hex of sha256 of the remote CLAUDE_CONFIG_DIR>`
    when one is set (the rule in data-model.md, applied to the remote path). It prints only the
    two fields. If the Keychain is locked, the account shows "no live reading".
  - **The plan**, from `claude auth status` run over SSH with the account's
    `CLAUDE_CONFIG_DIR`.
  - **Only when the host is awake.** A host that is asleep or unreachable is not woken for
    monitoring (`probeReachable`, `packages/jinn/src/engines/remote-stage.ts:562`). Its card
    shows the last reading and its age.
  - Its health, rate-limit memory, history and reset time are per account (FR-055), so a
    remote account at its limit holds only its own work.
- **FR-073**: **The Limits page.** `GET /api/engine-limits` MUST gain an additive
  `accounts` map: engine to a list of account snapshots. Each has today's snapshot fields plus
  the account key, its label, where it runs (local or a host) and the employees on it.
  `engines.claude` stays the default account, so existing clients are unchanged. The page shows
  one card per account, grouped by engine, with the default account first, as today. Each
  extra account's card names its employees. An engine with one account looks exactly as
  today.
- **FR-074**: **The Auto-Dispatch usage card.** `GET /api/auto-dispatch/usage` MUST take an
  optional `account`, defaulting to the default account, and the card gains an account
  switcher when there is more than one Claude account. Its title names the account.
- **FR-075**: **The board walk judges each account on its own.** The snapshot MUST carry, per
  account:
  - its windows, its exhausted flag, its prediction and its previous five-hour reading;
  - whether a session on it already holds capacity;
  - the starts the walk made on it in the current five-hour window.

  Each backlog candidate is annotated with the account it would run on: its assignee's account,
  or `unrouted` for an unassigned Todo, which the Dispatcher will route.

  The shipped `board-walk.md` prose is rewritten so that every rule applies **per account**:
  - the allowance thresholds;
  - "hold, never guess";
  - the concurrency rule;
  - at most one start per tick **per account**.

  An unrouted Todo is judged against the default account, and the walk passes the exhausted
  accounts to the Dispatcher as advice, the way it passes a preferred engine today
  (`packages/jinn/src/board-walk/walk.ts:142`). A child that still lands on an exhausted
  account waits for its own reset (FR-056).

  **Code gate.** `startTodo` (`packages/jinn/src/board-walk/apply.ts:245`) MUST refuse a
  start whose candidate's account is recorded exhausted. Today that is checked only in prose.

  **Known limit.** An unrouted Todo's account is known only after the Dispatcher routes it, so
  a child can still land on an exhausted account. It then waits for that account's reset, not
  the operator's (FR-056). The docs say so.
- **FR-075a**: **An account with no live reading.** This is common: an idle named account's
  access token has expired, so it has no API reading (FR-071), and its status-line snapshot is
  stale after 30 minutes (`packages/jinn/src/shared/engine-limits-claude.ts:163`). A remote
  host that is asleep, or a locked remote Keychain, gives the same result (FR-072). Applied per
  account, "hold, never guess" would never start anything on such an account.

  **Rule (the spec's choice; the operator may override): one probing start.** If the account
  is not recorded exhausted and no session holds it, the walk may start one Todo on it. That
  session refreshes the token and produces a reading, and the normal rules apply from the next
  tick. The rejected alternatives were holding (idle accounts would never be used, which
  defeats D6) and judging the account against the default one (the wrong account's
  allowance).
- **FR-076**: **The walk's own account: no custom fallback** (D9). The walk's turn runs on its
  runner's account (the default profile, unless `board-walk.md` names another engine). When
  that account is exhausted, `route-turn.ts:85` skips the tick as today, so every other
  account's work waits too. A walk turn never changes engine
  (`packages/jinn/src/sessions/rate-limit-handler.ts:138`), and that stays. Nothing new is
  added. The docs say the runner can be pointed at another engine.
- **FR-079**: **Per-account fallback chains** (D9). Each Claude account MAY have its own
  fallback chain, using the existing mechanism (`engines.<engine>.fallback`,
  `packages/jinn/src/shared/config-types.ts:94`, walked by
  `packages/jinn/src/shared/engine-fallback.ts:178`), as if each account were its own Claude
  installation:
  - accounts are declared under `engines.claude.accounts.<name>` with `configDir`,
    `fallback` and `fallbackModelMap` (data-model.md). An employee's `claudeConfigDir`
    matches a declared account by its canonical path (FR-050). The name labels its Limits card
    (FR-073). **The name is only an alias:** `claude:<name>` resolves to the FR-070 key
    `claude:<profile key>`, and every store keys on that, so renaming an account in config
    orphans no health, history or limits;
  - validation refuses two accounts with the same canonical `configDir`, a `configDir` equal
    to the default profile's directory, and a `configDir` that fails FR-050's rules;
  - `engines.claude.fallback` stays the default account's chain, unchanged;
  - a chain entry is an engine name (`codex`) or an account (`claude` for the default,
    `claude:<name>` for a declared one). Validation refuses unknown names and an account
    naming itself, and tolerates cycles, as `validateEngineFallbackChains`
    (`packages/jinn/src/shared/engine-fallback.ts:24`) does today;
  - an undeclared named profile, or a declared one with no `fallback`, has no fallback: it
    waits for its own reset (FR-056);
  - the walker skips an exhausted account using per-account health (FR-055). A substitute on
    another account runs as a fresh session on that account's profile with the recent history
    in its prompt, because a transcript cannot be resumed across profiles;
  - **substitution is tracked by account, not engine name.** Today's plumbing is keyed by
    engine: `beginEngineSubstitution` (`packages/jinn/src/sessions/engine-override.ts:38`) sets
    the session's engine and records the original, and `nextEngineSessionFields`
    (`packages/jinn/src/sessions/registry.ts:969`) stores thread ids per engine. A
    `claude` to `claude:friend` substitute would keep the engine name, overwrite the original
    account's thread id, and make the restore meaningless. So:
    - the override records the original and substitute **accounts**;
    - `engineSessions` is keyed by account. The default account keeps the key `claude`, so
      existing rows still read;
    - the profile resolver (FR-051) honours an active account override until its `until`, then
      hands the session back to its own account;
  - a scoped session's substitute keeps its stage dir (FR-020b) and binding, and only
    Claude-account entries apply to it (FR-026a);
  - putting `claude:<name>` in `engines.claude.fallback` moves the default account's
    sessions, including unscoped company sessions, onto that account when the default is
    limited. The docs say so;
  - remote employees keep today's rule that a substitute must run on their host. Account
    entries apply to local sessions only in v1;
  - a board-walk turn still never changes engine or account (FR-076).
- **FR-077**: **Migration of `board-walk.md`.** The operator owns `board-walk.md`, and it is
  never overwritten. The FR-044 rationale tells an instance to reconcile its own prose to the
  per-account wording, and to flag differing wording as a conflict.
- **FR-078**: **Unchanged with one account.** With no named profile and no remote Claude
  employee, the parts the code builds MUST match `main` byte for byte, on a fixed clock and
  fixed fixtures:
  - the snapshot JSON;
  - the `dispatcherSuffix` text;
  - the `/api/engine-limits` response.

  The new `accounts` fields are omitted when there is only one account, so they cannot break
  the comparison. The walk prompt is compared using the same `board-walk.md` on both sides,
  because Phase 6 rewrites the shipped template. The walk's decisions are checked by a
  decision-level test over the same fixtures, not by bytes.

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
  - the "not signed in" refusal as shown in chat;
  - the Limits page with one, two and three Claude accounts, including an exhausted account,
    a remote account with a live reading and one whose host is asleep (FR-073);
  - the Auto-Dispatch usage card's account switcher (FR-074).
- **FR-041**: The org tree MUST show each department's scope, and each employee's named
  profile, as badges. Open departments and the default profile show no badge.
- **FR-042**: The UI MAY edit a department's definition. When it does:
  - it writes `department.yaml`, as `PATCH /api/org/employees/:name` writes the employee's
    YAML today;
  - each write is atomic: a temp file in the same directory, then a rename;
  - the in-memory definitions are refreshed before the response returns;
  - a scope change runs the FR-015 stranding check.

  Hand-edited YAML stays the source of truth. The UI never holds state the files do not.

**Docs, instance migration and visual evidence** (every phase)

- **FR-043**: **Docs ship with the code.** Each phase PR MUST update, in the same PR, every
  doc its change makes wrong or incomplete:
  - the shipped template under `packages/jinn/template/` (the `docs/` reference pages and the
    shipped skills), which is what every instance reads;
  - the repository's own docs.

  A phase is not finished with its docs still to come. Each phase's docs task names the
  pages it touches.
- **FR-044**: **Instance migration.** A phase that changes anything under
  `packages/jinn/template/` MUST include the instance migration bundle for the next
  unreleased version in the same PR. It is generated with
  `pnpm --filter jinn-cli migration:generate -- --base-ref <latest release tag> --version <next version> --allow-unreleased`
  (`packages/jinn/scripts/instance-migration-bundle.mjs:29`), and it passes the same command
  with `migration:check`, which the "Migration bundle" workflow runs. When two phases are in
  flight together (Phase 4 beside Phases 1 to 3), the one that merges second rebases and
  regenerates, because the manifest hashes cover the combined template change. Its release-rationale section says plainly:
  - what an instance must merge into its own `CLAUDE.md` and `docs/`, and what is only
    informational because shipped skills are rewritten at boot;
  - what the gateway does by itself at boot: the `department_scopes` table, the
    `sessions.scope_department` column, and any per-account limit state;
  - that an instance with no `department.yaml` and no `claudeConfigDir` needs nothing else,
    because every department stays `open` and every employee stays on the default profile;
  - how an operator opts in: writing a `department.yaml`, signing a profile in and setting
    `claudeConfigDir`, and for remote hosts, any `remote` settings.

  Phases that land before one release share that version's bundle. Each phase adds its own
  paragraph to the rationale, so nothing an earlier phase wrote is lost.
- **FR-045**: **Visual testing is part of done.** Every phase that changes the web UI MUST
  capture each new or changed element (FR-040) against a seeded sandbox gateway:
  - in light and dark;
  - at desktop and phone widths;
  - in each state the element has, for example open, scoped, dedicated, a refused
    `department.yaml`, not signed in, and an account at its limit.

  The screenshots go on the PR, and senior QA reviews them as part of the review, not after
  it. A UI change without them is not ready for review.

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
- **Remote department stage directory**: a pushed copy of the stage directory on each remote
  host a scoped member uses, at `<remote.root>/.jinn-departments/<slug>/`.
- **Employee Claude profile** (employee YAML, `claudeConfigDir`): the profile its local
  sessions run as. Remote employees keep `remoteClaudeConfigDir`.

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
- **SC-005**: Every FR-040 element has screenshots on its phase's PR, in light and dark, at
  desktop and phone widths, in each of its states (FR-045).
- **SC-008**: Every phase PR that touches `packages/jinn/template/` passes
  `pnpm migration:check`, and its bundle's rationale covers that phase (FR-044).
- **SC-006**: Two profiles with independent limits: marking one rate-limited leaves sessions on
  the other startable, and the reverse.
- **SC-009**: With two local Claude accounts, the Limits page shows two Claude cards with their
  own windows and employees, and the usage card switches between them. The board walk, with
  one account exhausted, starts a ready Todo on the other and refuses one on the exhausted
  account in code (FR-075). With one account, the page, card and walk match `main`
  (FR-078).
- **SC-007**: For a scoped remote employee, a test per `employeeRemoteTarget` caller, the
  rate-limit retry included, asserts the remote stage dir as cwd, and the environment file
  carries `JINN_DEPARTMENT`. The grep test in FR-061 passes. A sync test
  shows the stage dir's inode unchanged across an update, with a dropped skill removed. The scoped farm script,
  run under `sh` against temporary directories, makes no link into the company home and no
  `CLAUDE.md` link. The unscoped remote staging scripts are byte-identical to `main`.

## Assumptions

- Single operator and one gateway. Engines run as the operator's user on the gateway's
  machine, or as the configured remote user on a remote host. Scoping is a gateway guardrail,
  not an OS boundary (see "Scope of the boundary").
- The operator signs each profile in by hand, once. The gateway never runs `/login`.
- Concurrent employees in one department share its working directories. Worktrees remain the
  answer.
- Personas do not vary per department. A different role means a separate employee.
- An employee belongs to one department, so a scoped employee works in exactly one scope.
  Grouping company work by client inside one department is not part of this feature; labels and
  sprints already exist for that.
- Cron stays company-level in v1.
