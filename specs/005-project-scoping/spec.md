# Feature Specification: Projects and Project-Scoped Employees

**Feature Branch**: `feat/project-scoping-spec`

**Created**: 2026-10-05

**Status**: Draft. Waiting on the operator's answers to Q1–Q7 (end of this file). Nothing is
implemented until they are answered.

**Input**: Marid issue #90 (upstream proposal hristo2612/jinn#81). The operator wants projects
as a first-class scope. Todos are raised inside a project. An employee can be limited to
certain projects, for example a "Marid fork" project with its own employees. A scoped
employee must not be able to reach the company setup, and the skills it sees can be limited.
Enforcement is server-side, not only in the UI. Unscoped employees and existing Todos behave
exactly as they do today.

## Why This Matters *(constitution Principle II)*

On its own this is **rung 4**: the operator gets a way to bound a remit, and no decision moves
to the system. It belongs in this fork because Principle II's own condition for autonomy is
"a stated ceiling and a way for the operator to stop it". Today the only ceiling on an
employee's reach is the whole instance. With project scoping, a set of employees can be left to
pick up and run a project's backlog unattended, with a blast radius the operator chose ahead
of time. It is the bound that makes unattended running acceptable, so it is part of that
feature rather than a separate one.

## What the tree does today *(facts the spec depends on)*

research.md has the full audit with `path:line` citations. Three facts shape every design
choice below.

1. **Nothing in the data model resembles a project.** There is no `project` field on Todos,
   sessions, employees or config. Todos have `department`, `assignee`, sprints and labels.
   Sprints and labels live in join tables, because the boot verifier refuses any column added
   to `work_items` (`packages/jinn/src/work-items/sprints-schema.ts:5`).
2. **The only per-employee allow-list is `mcp`** (`packages/jinn/src/shared/types.ts:529`).
   Every skill is linked into the single shared `~/.jinn/.claude/skills`
   (`packages/jinn/src/gateway/watcher.ts:38`). A Todo's `dispatchConfig.skills` *adds* a "read
   this skill" line to the prompt and never takes one away
   (`packages/jinn/src/work-items/dispatch-config.ts:253`).
3. **Gateway and MCP checks are cooperative today, not a boundary.** Every local engine runs
   with a shell, with permissions bypassed, with cwd `$JINN_HOME`
   (`packages/jinn/src/sessions/turn/engine-run.ts:46`), and with the operator bearer token in
   its environment (`packages/jinn/src/gateway/server.ts:504`). Any employee can therefore act
   as operator with `curl`, read `sessions/registry.db`, or edit `org/` and `config.yaml`
   directly. The MCP identity code says so itself: "defense-in-depth … not an internet auth
   boundary" (`packages/jinn/src/mcp/identity.ts:42`). Three tool-level gaps make it worse:
   - `read_knowledge` can read `secrets/`, which includes the key every session capability is
     derived from.
   - `publish_attachment` reads any absolute path.
   - When auth is off, which is the loopback default, unauthenticated `GET`s are served
     (`packages/jinn/src/gateway/api.ts:841`).

Fact 3 is why **Q1** is the first decision. Server-side enforcement in the gateway is
necessary, but on its own it does not stop a scoped employee from reaching the company setup.
It stops one only when the scoped employee's engine is also contained.

## User Scenarios & Testing *(mandatory)*

### User Story 1: The operator groups Todos into a project (Priority: P1)

The operator creates a project called "Marid fork" on a new Projects page and raises Todos
inside it from the board's create dialog. On the board they switch to the project and see only
its Todos, each with a project badge. Existing Todos carry no badge and stay where they were.

**Why this priority**: every later story needs projects and Todo membership. On its own it
already gives the operator a grouping, with no change in behaviour for anyone else.

**Independent Test**: create a project, create two Todos in it and one outside it, then
filter the board by the project. The list API, the board and the switcher all return exactly
the two project Todos. With no filter set, the board returns all three, exactly as before.

**Acceptance Scenarios**:

1. **Given** no projects exist, **When** the operator opens the board, **Then** it looks and
   behaves exactly as today: no project filter chip and no badge.
2. **Given** a project P, **When** the operator creates a Todo with project P, **Then** the
   Todo shows P on its card, in the list row and in the detail rail. Its sub-tasks show P too,
   because they inherit it (FR-004).
3. **Given** a Todo in P, **When** the operator changes its project to none, **Then** the Todo
   becomes company-level. A `project_changed` event records the old and new values.
4. **Given** P is archived, **When** anyone tries to create a Todo in P or move one into it,
   **Then** the request is refused. P's existing Todos stay readable and P still appears under
   "Archived" in the switcher.

---

### User Story 2: A scoped employee only sees its project (Priority: P1)

The operator scopes a new employee, `marid-dev`, to "Marid fork". From inside a `marid-dev`
session:

- `list_work_items`, `search_work_items`, `list_sessions` and `list_employees` return only
  "Marid fork" Todos, "Marid fork" sessions, and the employees scoped to "Marid fork".
- `get_work_item` on a company Todo returns *not found*.
- `list_cron_jobs` and `cost_report` are refused, and the gateway refuses config reads.

**Why this priority**: this is the feature the operator asked for. US1 is only the
prerequisite.

**Independent Test**: these are the server-side enforcement tests, FR-010 to FR-016. Each one
drives the real API handler as a capability-bound session of a scoped employee, against a
seeded registry that holds company Todos, Todos in two projects, sessions in each, and
employees scoped and unscoped. Every route in the scoped-caller table (plan.md) gets at least
one allow case and one refuse case.

**Acceptance Scenarios**:

1. **Given** `marid-dev` is scoped to P, **When** it lists Todos with no filter, **Then** it gets
   only P's Todos. If it passes a filter for another project, it gets an empty page. It is
   never told the other project exists.
2. **Given** a company Todo `ACM-5`, **When** `marid-dev` reads it, comments on it, attaches to
   it, assigns it, links it or dispatches it, **Then** every call returns 404 `not found`, and
   the response is identical to the one for an id that does not exist.
3. **Given** `marid-dev` creates a Todo, **When** it passes no project, **Then** the Todo is
   created in P. **When** it passes a project other than P, **Then** the request is refused.
4. **Given** `marid-dev` tries to spawn or delegate to `senior-developer`, who is unscoped,
   **Then** the request is refused (Q2-a). **When** it spawns `marid-qa`, who is scoped to P,
   **Then** the spawn succeeds and the child session is bound to P.
5. **Given** an unscoped employee such as the COO, **When** it does any of the above, **Then**
   the behaviour is byte-for-byte what it is today (SC-002).

---

### User Story 3: A scoped employee cannot get around the gateway (Priority: P1, if Q1 = B)

A `marid-dev` session runs in the project's own stage directory rather than in `$JINN_HOME`,
with a minimal environment and a sandbox. From its shell it cannot:

- read `$JINN_HOME` (secrets, `registry.db`, `org/`, `config.yaml`, the company `CLAUDE.md`,
  other sessions' MCP configs);
- find the operator bearer token in its environment;
- reach the gateway with operator authority.

It can read and write the project's working directories, push with git, and run builds.

**Why this priority**: without this story, US2 holds only for an employee that follows its
instructions. Q1 decides whether the operator wants it in v1.

**Independent Test**: from a real Claude session of a scoped employee, scripted with
`claude -p` and the same flags the gateway uses, each of these must fail:

- `cat ~/.jinn/config.yaml`
- `sqlite3 ~/.jinn/sessions/registry.db .tables`
- `env | grep JINN_GATEWAY_TOKEN`
- `curl -s 127.0.0.1:<port>/api/work-items`
- `node <dist>/mcp/server-entry.js --jinn-session-id <other session> --jinn-home ~/.jinn`

`git status` in a working directory and a build of the project must succeed. Plan.md, Phase 0
proves this is reachable before anything is built on it.

**Acceptance Scenarios**:

1. **Given** a contained session, **When** its shell reads any path under `$JINN_HOME` outside
   its stage directory, **Then** the read fails with a permission error from the sandbox.
2. **Given** a contained session, **When** it lists its environment, **Then** it sees no
   `JINN_GATEWAY_TOKEN`, none of the gateway's inherited credentials, and only the secrets the
   project references by name (FR-030).
3. **Given** a contained session, **When** it calls the gateway without the session
   capability, **Then** every route returns 401. This includes the `GET`s that loopback serves
   unauthenticated today (Q6).

---

### User Story 4: A project limits the skills and Notes its employees see (Priority: P2)

The operator gives "Marid fork" a skill allow-list (for example `self-update`, `review` and
the `speckit-*` set) and a project Notes folder. A scoped session is offered only those
skills: in its engine's skills directory, in the system prompt, and through
`dispatchConfig.skills`. `search_knowledge` and `read_knowledge` cover only:

- the project's Notes folder;
- the company Notes the operator has explicitly shared with the project.

**Why this priority**: it narrows context and stops company knowledge leaking into the
project. It is not needed for US2's boundary.

**Independent Test**: from a scoped session, `search_knowledge` for a term that appears in
both a company Note and a project Note returns only the project Note. Reading a skill
outside the allow-list is refused. The engine's skills directory, the stage dir's
`.claude/skills`, contains exactly the allow-listed skills.

**Acceptance Scenarios**:

1. **Given** the project allows skills S1 and S2, **When** a scoped session starts, **Then** its
   stage dir links exactly S1 and S2, and its prompt names only those skills.
2. **Given** a Todo in P whose `dispatchConfig.skills` names S3, which is not allowed, **When**
   it is dispatched to a scoped employee, **Then** the dispatch is refused with a reason that
   names S3.
3. **Given** company Note N is shared with P, **When** a scoped session searches, **Then** N
   is included. An unshared company Note never is.

---

### User Story 5: The operator manages scope from the UI (Priority: P2)

From the Projects page the operator can:

- create, rename, describe and archive a project;
- set its working directories, skill allow-list, shared Notes and secret references (by name);
- see which employees are scoped to it.

On an employee's edit panel the operator sets the project scope: unrestricted, or a list of
projects. A project switcher in the shell narrows the board and the sidebar. Sessions carry
the project's badge in the sidebar list and in the Todo session tree.

**Why this priority**: until it exists, scope can only be set by editing YAML or calling
REST.

**Independent Test**: Playwright against a throwaway sandbox gateway, the same pattern as
`scripts/verify-chat-grid-drop.sh`. It checks every new or changed element in light and dark,
with screenshots attached to the PR (FR-040).

---

### Edge Cases

- **A Todo moves out of a project while a scoped session is working it.** The session's next
  call on that Todo returns 404. The session is not killed; the turn finishes and the run is
  recorded. It shows as an `escalated` ledger event, so the operator sees it.
- **An employee's scope is narrowed while its sessions are live.** The new scope applies from
  the next request, because scope is read from the live roster on every request. Sessions bound
  to a project the employee lost are refused on every route except their own transcript, and
  no new turn starts in them (`refuseTurn`).
- **A sub-task is created under a project Todo.** It inherits the root's project. A sub-task
  cannot set a different project: membership lives on the root, as sprints do
  (`packages/jinn/src/work-items/sprint-membership.ts:71`).
- **Re-parenting.** Moving a Todo under a parent in a different project changes its effective
  project. Scoped callers may only re-parent within their project.
- **Linking.** A relation between Todos in two different projects, or between a project Todo
  and a company Todo, is refused for scoped callers. Unscoped callers may link anything, as
  today, and a scoped reader sees such a relation as "1 hidden relation".
- **An archived project with a live scoped employee.** The employee can read the project's
  Todos but cannot create new ones. A new session for it starts only on an existing Todo.
- **A project is deleted.** v1 has no hard delete, only archive. That keeps the id stable for
  history, as the issue asks.
- **Project names.** Names are unique ignoring case. `none` and `all` are reserved, because the
  filter grammar uses them (`project=none` means company-level).
- **Todo numbering.** Unchanged. A Todo keeps its department prefix. The project is a separate
  dimension, so `ACM-80` can be in "Marid fork".
- **Scoped system employees.** The Todo Dispatcher, board walk and Todo Shaper stay unscoped and
  may not be scoped (v1). They respect assignee scope: they never route a project Todo to an
  employee outside its project (FR-015).
- **The remote MCP connector.** It is the operator's own door
  (`specs/004-remote-mcp-connector/spec.md`). It stays unscoped and sees projects like the
  operator does.

## Requirements *(mandatory)*

### Functional Requirements

**Projects and membership**

- **FR-001**: The system MUST store projects with:
  - a stable id (`prj_` followed by 12 hex characters) that never changes on rename or archive;
  - a name, unique ignoring case;
  - a description;
  - `archived_at`, `created_at` and `updated_at`.
- **FR-002**: A top-level Todo MUST belong to zero or one project. No membership means
  company-level. **No existing Todo is migrated.**
- **FR-003**: The project MUST be settable at create time and changeable afterwards through
  REST and the web UI. Every change MUST write a `project_changed` event.
- **FR-004**: A sub-task's project MUST be its root's project. The read API reports it as
  `project` on every Todo in the tree.
- **FR-005**: The Todo list API MUST accept `project=<id>|none`. `none` means company-level,
  and leaving the parameter out means all. The list and detail payloads MUST carry
  `project: {id, name} | null`.
- **FR-006**: An archived project MUST refuse new members, through creation or move. It stays
  readable.

**Employee scope**

- **FR-007**: An employee MAY carry `projects: [<project id>, …]` in its org YAML. If the key
  is absent or empty, the employee is unrestricted, exactly as today. The field MUST be
  writable through `PATCH /api/org/employees/:name`, which stays operator-only.
- **FR-008**: Every session of a scoped employee MUST be bound to exactly one of its projects
  when it is created. The binding comes from the first of these that applies:
  1. the linked Todo's project;
  2. an explicit `project` on spawn;
  3. the employee's only project.

  If none applies, the spawn is refused. The binding is stored on the session and never
  changes afterwards.
- **FR-009**: A session of an unscoped employee MAY carry a project, for badges only. It comes
  from a linked project Todo. It MUST NOT restrict that session in any way.

**Server-side enforcement** (applies to every request from a capability-bound session of a
scoped employee; "P" below is the session's bound project)

- **FR-010**: **Default deny.** The gateway MUST refuse every route that is not on the
  scoped-caller allow-list in plan.md. That table is the single source of truth. A new route
  that is not in it is refused for scoped callers, so it fails closed. The table is enforced at
  the identified-caller gate, at the same point as `refuseRemoteMcpRoute`
  (`packages/jinn/src/gateway/api.ts:1181`).
- **FR-011**: **Todos.**
  - List, search, tree and board responses MUST include only P's Todos.
  - Every per-Todo route MUST answer 404 for a Todo outside P. The response MUST be
    indistinguishable from the one for an unknown id.
  - This covers: get, patch, status, assign, comment, attach, relations, dispatch,
    dispatch-config, labels, kept, sprint and sessions.
  - Creates MUST land in P.
  - A move out of P MUST be refused.
- **FR-012**: **Sessions.**
  - `list_sessions`, `read_session`, `search_sessions`, `search_messages` and
    `get_message_context` MUST cover only sessions bound to P.
  - `send_to_session` and `stop_session` MUST target only sessions bound to P.
- **FR-013**: **Org.**
  - `list_employees`, `get_employee` and `find_employees` MUST return only employees scoped to
    P.
  - The system-prompt roster MUST show the same set.
  - Department, label and sprint *administration* MUST be refused.
  - Applying an existing label to a P Todo is allowed.
- **FR-014**: **Company control plane.** Config, cron, cost report, connectors, the Workflow
  API, Notes outside the project and the skills API MUST be refused.
- **FR-015**: **Spawning and delegation.**
  - `spawn_session`, `delegate_task` and `dispatch_work_item` from a scoped caller MUST target
    only employees scoped to P (Q2-a).
  - The child session MUST be bound to P.
  - From *any* caller, assigning, delegating or dispatching a P Todo to an employee scoped to
    other projects MUST be refused, whether the caller is the operator or the Dispatcher.
    An unscoped employee remains a valid assignee for any Todo.
- **FR-016**: **Files.**
  - `list_files` and `read_file` MUST be refused for scoped callers. The managed `files`
    table carries no owner (`packages/jinn/src/sessions/migrate.ts:117`).
  - Todo attachments on P Todos stay available.
  - `publish_attachment` MUST accept only paths inside P's working directories or the
    session's stage directory.

**Containment** (v1 only if Q1 = B)

- **FR-020**: A session of a scoped employee MUST run with cwd set to a generated project stage
  directory, not `$JINN_HOME`.
- **FR-021**: Its environment MUST be built from an allow-list, not inherited from the gateway.
  It MUST NOT contain `JINN_GATEWAY_TOKEN`, and MUST NOT contain any variable the gateway
  inherited beyond the allow-list.
- **FR-022**: Its shell MUST be denied reads and writes under `$JINN_HOME` outside its stage
  directory, and MUST be denied writes outside P's working directories, the stage directory
  and the temp and cache directories.
- **FR-023**: Its MCP capability MUST be passed to the MCP server by the gateway and MUST NOT
  be derived from the key file inside the session's reach. `packages/jinn/src/mcp/server-bootstrap.ts:25` derives it
  from the key today.
- **FR-024**: The gateway MUST refuse unauthenticated requests from a contained session's
  shell. A request carrying neither the bearer token nor a valid session capability gets 401
  on every route, `GET` included (Q6).
- **FR-025**: In v1 a scoped employee MUST use the `claude` engine. Config validation refuses a
  scoped employee on any other engine, with a message saying why. Codex, Grok and the others
  bypass their sandboxes today, and containing each of them is its own piece of work.

**Skills, Notes and instructions**

- **FR-026**: A project MAY carry a skill allow-list. A scoped session MUST be offered only
  allow-listed skills, through all three of:
  - the stage dir `.claude/skills` links;
  - the prompt;
  - `dispatchConfig.skills` validation.

  An empty allow-list means none, not all.
- **FR-027**: A project's Notes MUST live under `knowledge/projects/<project id>/`. For a scoped
  caller, `search_knowledge`, `read_knowledge` and the note tools MUST be rooted there, plus
  the company Notes the project explicitly shares. `docs/` and other company paths are
  excluded unless they are shared.
- **FR-028**: A project MAY carry an instructions file, `knowledge/projects/<id>/INSTRUCTIONS.md`.
  The scoped session's engine loads it as its `CLAUDE.md`, from the stage dir. Whether the
  company `CLAUDE.md` is also included is set per project (Q5). The default is no.

**Secrets**

- **FR-030**: A project MAY declare environment variables as `{ name: ENV_NAME, secret: <key in
  the secrets store> }`. Values are resolved when a session spawns, from `secrets/` only. Raw
  values MUST NOT be written to the DB, YAML, logs, events, API responses or the UI. The API
  returns only the names and whether each one resolves.
- **FR-031**: A reference to a secret key that does not exist MUST NOT block the spawn. The
  variable is left out, and the project page shows it as unresolved.

**Compatibility**

- **FR-035**: With no projects defined and no scoped employees, every API response, MCP
  manifest, prompt and engine argv MUST be byte-identical to `main` (SC-002).
- **FR-036**: The core MCP manifest MUST NOT grow (Q4-a). Scoped callers get their project
  implicitly from the session binding.

**UI and verification**

- **FR-040**: Each of these elements MUST be verified in light and dark with screenshots on
  the implementation PR:
  - the project switcher;
  - the board filter chip and the card/list badge;
  - the project field in create and detail;
  - the Projects page;
  - the employee scope control;
  - the session badges.

### Key Entities

- **Project**: stable id, name, description, archived flag, plus its configuration:
  - working directories (zero or more absolute paths);
  - skill allow-list;
  - shared company Notes (relative paths);
  - environment secret references;
  - instructions mode.

  It is not a repo or a working directory. One project can list several of them, and several
  projects can list the same one.
- **Project membership**: a top-level Todo belongs to a project. Sub-tasks inherit the root's
  project.
- **Employee project scope**: the list of project ids on an employee. Empty means
  unrestricted.
- **Session project binding**: one project per session, fixed when the session is created.
  It is the "P" in every enforcement rule.
- **Project stage directory** (Q1 = B): a generated cwd per project. It holds the
  `.claude/skills` links, `CLAUDE.md`, and the settings that carry the sandbox.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every route in the scoped-caller table has an allow test and a refuse test that
  drive the real API handler. A test also enumerates every registered route and fails if any
  route is missing from the table. That stops a new route from slipping past default deny
  unseen.
- **SC-002**: With no projects and no scoped employees, the full test suite is unchanged from
  `main`. In addition, a recorded comparison against `main` shows these are identical:
  - the MCP manifest;
  - `buildContext` output for a fixed roster;
  - the engine argv.
- **SC-003** (Q1 = B): the US3 escape script fails on every escape attempt and succeeds on
  every allowed action, run against a live sandbox gateway. Its output is attached to the PR.
- **SC-004**: The core MCP manifest token counts in `tool-manifest-budget.test.ts` do not rise.
- **SC-005**: Every FR-040 element has a light screenshot and a dark screenshot on the PR.

## Assumptions

- Single operator, single machine, single OS user. Isolation between projects is enforced by
  the gateway, plus the engine sandbox when Q1 = B. It is not an OS-user boundary.
- Inside a project, concurrent employees can still affect each other through shared working
  directories. Worktrees remain the answer, as today (issue question 5).
- A persona does not vary per project. Scope is an allow-list. An employee that needs a
  different role in a project is a separate employee, which is the operator's stated model of
  a dedicated set of employees (issue question 2).
- No client layer above projects. Nothing in v1 rules one out: projects would gain a nullable
  client id later. No column or key is reserved for it now (Principle V; issue question 7).
- Cron jobs stay company-level in v1. A scoped employee has no cron jobs, and a cron job may
  not target a scoped employee (refused at config validation). Project-owned cron is a
  follow-up if the operator needs it.
- User-level Claude config (`~/.claude/skills`, `~/.claude/CLAUDE.md`, plugins) is outside
  `$JINN_HOME` and is still loaded by contained sessions. Filtering it needs a per-project
  `CLAUDE_CONFIG_DIR`, which also needs a separate engine login. That is out of scope for v1
  and listed as a known leak.

## Open Questions for the Operator

Each question has options and a recommendation. Plan.md and tasks.md assume the
recommendation, and say where an answer would change them.

### Q1: Is "cannot reach the company setup" a guardrail or a boundary?

- **A. Guardrail.** Enforce scope in the gateway and MCP only (FR-010 to FR-016). A scoped
  employee that follows its tools stays in scope. One that runs `curl` with the inherited token,
  or `cat`s `~/.jinn`, does not. Cost: Phases 1–3 only.
- **B. Boundary (recommended).** A as above, plus containment (FR-020 to FR-025): stage-dir
  cwd, an allow-listed environment with no token, Claude Code's sandbox denying `$JINN_HOME`,
  the capability passed rather than derived, and gateway auth on (Q6). Cost: Phase 0 spike plus
  Phase 4. The scoped employee is limited to the `claude` engine.
- **C. OS isolation.** A separate macOS user or a container per project. This is the real
  boundary, but it is out of scope as infrastructure. It is listed so the choice is explicit.

Why B: the issue's wording, "must not reach the main setup", is a boundary claim, and A cannot
honour it. A Phase 0 spike proves B before anything else is built. If the spike fails, v1
ships A and says plainly in the docs that it is a guardrail.

### Q2: Can a scoped employee reach employees outside its project?

For example, a shared QA reviewer.

- **a. Project members only (recommended).** The project needs its own reviewer, such as a
  `marid-qa` employee scoped to it. This is simple, and there is no confused deputy.
- **b. Scope inherits down the lineage.** A scoped session may spawn any employee, and the
  child is bound to P and restricted as if it were scoped. A shared reviewer then works across
  projects, but every employee becomes potentially contained, so the containment work applies
  to all of them.

### Q3: Where do project definitions live?

- **a. Registry DB (recommended).** `projects` table, `work_item_projects` join table and child
  config tables. This follows the sprints precedent. Membership gets foreign keys, one
  transaction covers Todo plus project writes, and the registry backup carries them. Employee
  scope stays in org YAML with the rest of the employee.
- **b. YAML under `~/.jinn/projects/`**, mirroring `org/` as the upstream proposal suggested.
  You can edit it by hand and diff it, but membership would point at ids the DB cannot check,
  and you get two sources of truth.

### Q4: Should agents be able to file Todos into a project by name?

The core MCP manifest is at 4155 of 4156 tokens on the binding wrapper
(`packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts:11`).

- **a. No new MCP parameters (recommended).** Scoped sessions get their project implicitly.
  Unscoped agents' Todos inherit the project of their parent Todo or of their own bound
  session. Only the operator, through the UI or REST, files into a chosen project directly.
- **b. Add `project` to `create_work_item`, `list_work_items` and `edit_work_item`.** That is
  roughly 20 tokens, which have to be bought back by trimming other descriptions in the same
  PR. Needed only if the COO is to file "into Marid fork" from chat.

### Q5: What company context does a scoped session get?

- Instructions: **project `INSTRUCTIONS.md` only (recommended)**, or the project file plus the
  company `CLAUDE.md`. The company file names the whole org, the routing rules and the
  operator's other work, so including it leaks exactly the context the issue wants kept out.
  The price is that the project file has to carry the rules a project employee needs: review
  lifecycle, branch rules, client confidentiality.
- Company Notes and `docs/`: **excluded unless the project lists them (recommended)**, or
  included by default. This matches the issue's default for a scoped employee.

### Q6: Fix three security gaps for everyone, or only for scoped sessions?

These gaps exist today without any projects:

- `read_knowledge` can read `secrets/`, including the session-capability key, and so can forge
  any session's identity, the portal's included;
- `publish_attachment` reads any absolute path;
- loopback serves unauthenticated `GET`s.

- **a. For everyone, as a small PR ahead of this feature (recommended).** Apply the existing
  protected-home policy (`packages/jinn/src/shared/protected-home-entries.ts:41`) to
  `read_knowledge` and `publish_attachment`. Leave loopback `GET`s alone for unscoped use.
- **b. Only for scoped sessions**, as part of FR-016/FR-024.

Separately, under Q1 = B, the gateway refuses requests that carry neither the bearer token nor
a capability. That means the web UI needs the token as well (pairing once, which is the flow
used when `gateway.authRequired` is on), or the refusal applies only to requests from the
stage dir's sandbox, which Phase 0 must show can be told apart. **Your approval is needed to
turn gateway auth on** if Phase 0 shows that is the only way.

### Q7: Are project secret references in v1?

- **Yes (recommended).** Under Q1 = B the contained environment drops everything the gateway
  inherited, so whatever credential the project's work needs, for example `GH_TOKEN` for a
  push, has to come from a named reference. It is cheap: a lookup of names in `secrets/` at
  spawn time.
- **No.** Defer it. Contained sessions then rely on credential files the sandbox leaves
  readable, such as `~/.config/gh`.

### Decided by default (say if you disagree)

- A project has zero or more working directories, and is not a repo (issue question 1).
- A sub-task inherits the root's project. Moving it re-scopes it.
- An out-of-scope id returns 404, never 403, so existence is not leaked.
- Archiving is the only kind of deletion in v1.
- Cron, connectors, cost reports and config are refused for scoped callers.
- A scoped employee has no cron jobs.
- The system employees and the remote connector stay unscoped.
- No client layer in v1.
