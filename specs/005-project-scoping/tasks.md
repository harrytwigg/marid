# Tasks: Projects and Project-Scoped Employees

These tasks follow the operator's decisions of 2026-10-05 (spec.md, "Operator decisions").

## How the work ships

**Order.** Each phase is its own PR off `main`. The build order is 1 → 2 → 3. The
per-employee Claude account is a separate follow-up spec, written once Phase 3 has merged
(spec.md, "Follow-up").

**Rules for every phase.**

- Re-verify the plan's `path:line` rows before starting.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` locally. The repo has no
  running CI, so say in the PR that verification was local.
- Do not grow any file that is at or over its size budget.
- Commits, branch names and PRs use no internal tracking numbers.

**Visual evidence.** Every UI task captures light and dark screenshots with the sandbox
gateway script from T031. The screenshots go on the PR with `gh pr comment --attach`.

`[P]` means the task can run in parallel with others in its phase.

## Phase 1: projects as a grouping (junior-developer, then junior QA)

### Backend

- [ ] T020 Write `gateway/project-registry.ts`.
  - It scans `$JINN_HOME/projects/*.yaml` using the parser `org.ts` uses.
  - It applies data-model.md's scan rules:
    - identity problems refuse the file, but keep the last good definition of an id that was
      already loaded;
    - a duplicate id keeps the definition already loaded and refuses the newcomer;
    - content problems drop only the entry, with a warning;
    - a missing `projects/` gives an empty set, with no log line.
  - It records ids it has seen in `project_ids_seen`, and reports an id that comes back under a
    different name.
  - It keeps the last good definition by file path, and loads files in lexical file-name
    order.
  - It watches the directory, as `gateway/watcher.ts:130` does, and tolerates the directory
    being absent.
  - It emits `company:changed {entity:"project"}`.
  - Add `projects` to `ARCHIVE_INCLUDES`.
- [ ] T021 Write `work-items/projects-schema.ts`. It defines `work_item_projects` per
  data-model.md, registered in `V2_ADDITIVE_TABLES` and `REQUIRED_TABLE_SQL`, plus a root-only
  boot data check modelled on `sprintRowsAreSound`. Write `work-items/project-membership.ts`:
  a root-only move that writes a `project_changed` event, and a batch read of project refs.
- [ ] T022 Add the `project` filter (`id|none`) to the store list, next to `sprint`. Then:
  - add the `project` payload (`ProjectRef` with `known`) to the compact and detail wires;
  - accept `project` at create, through a new `gateway/work-item-create-project.ts` called on
    one line, as `work-item-create-sprint.ts` is;
  - make a Todo created with `parentId` inherit its parent's project;
  - add `project` to the idempotency hash only when it is set;
  - refuse an archived or unknown project.
- [ ] T023 Write `gateway/projects-api.ts`:
  - `GET /api/projects` and `GET /api/projects/:id`;
  - `POST /api/projects`, which writes a new YAML with a generated `prj_` + 12-hex id;
  - `PATCH /api/projects/:id`, which rewrites that file.

  `POST` also seeds `knowledge/projects/<id>/state.md` in the company `state.md` format
  (FR-028).

  Both writes are atomic (temp file, then rename), and the registry refreshes before the
  route responds.

  The route list also includes:
  - `PUT /api/work-items/:id/project`.

  Writes are operator-only (`control-plane-routes.ts`). Refuse writes to `dedicated` until
  Phase 2. Mount the module with one line in `api.ts`, and pay for that line by moving
  `GET /api/sessions` into `gateway/sessions-list-api.ts`.
- [ ] T024 Tests:
  - scan rules: one case per identity refusal; a content problem drops only the entry and keeps
    the project; a duplicate id keeps the first;
  - a broken edit to a loaded file keeps its last good definition;
  - a missing `projects/` gives an empty set and no log line;
  - id reuse under a new name is reported;
  - a project create followed at once by a Todo create in it succeeds;
  - rename or move a file and the id is kept;
  - filter semantics (`none`, an unknown id, an archived project);
  - root-only membership and sub-task inheritance;
  - archived and unknown projects refused at create and move;
  - FR-033: each protected tree, an ancestor of `$HOME`, a non-git work root, and a dotfiles
    home;
  - YAML writes from `POST` and `PATCH` round-trip through the scan.

### Web

- [ ] T026 [P] Write `lib/project-api.ts` and `hooks/use-projects.ts`, and wire query
  invalidation on `company:changed {entity:"project"}`.
- [ ] T027 [P] Board:
  - add the `project` filter in the four `lib/todos.ts` places and in the `use-board` query key;
  - add a filter chip;
  - show the project as a badge in card Row 1 and on list rows, coloured with `deptHue`;
  - show an unknown project as "unknown project".
- [ ] T028 [P] Add the create dialog `PropertyChip`, and a detail rail row modelled on
  `sprint-rail-row.tsx`.
- [ ] T029 [P] Build the Projects page:
  - wire the route, the nav entry and talk coverage;
  - use `PageScaffold` sections for details, working directories, skills, shared Notes,
    members (read-only) and archive;
  - show `dedicated` read-only for now;
  - add an "Edit YAML" hint that shows the file path.
- [ ] T030 [P] Build the project switcher, as a status bar contribution and in the chat
  sidebar header. It drives the board filter and the sidebar list.
- [ ] T031 Write `scripts/verify-projects.sh`, `playwright.projects.config.ts` and a seed
  script, following the chat-grid-drop sandbox pattern. Capture T027–T030 in light and dark.

## Phase 2: scoped employees (senior-developer, then senior QA; T048 and T049 go to the junior as their own Todos)

- [ ] T040 Enumerate every API route on `main` and every upgrade path, and classify each
  against plan.md's table. Write the route-enumeration test.
- [ ] T041 Employee `projects` (FR-007):
  - in YAML, absent means `all` and present means scoped, with null, empty or unknown failing
    closed;
  - on the wire, `projectScope: "all" | string[]`;
  - `WRITABLE_FIELDS`, where PATCH refuses an empty list;
  - validation: claude-only, no system employees, no cron job may target a scoped employee.
- [ ] T042 Add `sessions.project_id`, set only for scoped employees in `spawnSession` by
  FR-008. Use `parent_session_id` as the FR-013 requester. Refuse connector-originated
  sessions for scoped employees.
- [ ] T043 Write `gateway/project-scope/{caller,rules,paths}.ts`. Add the gate line beside
  `gateway/api.ts:1181` and the scoped refusal in `gateway/upgrade-guards.ts`.
- [ ] T044 Write `gateway/project-scope/read-routes.ts` for every scoped list and search row,
  including the `ids=`, `pinned` and `q` branches and the hidden counts.
- [ ] T045 Write `mayHoldTodo` (FR-015).
  - Add a guard at every SQL writer of `assignee`. Enumerate them first with
    `git grep -n "SET assignee\|assignee = ?\|INSERT INTO work_items" packages/jinn/src`.
    On `main` that finds the `store.ts` insert, the two dynamic update paths in `store.ts`, and
    `work-items/assignment.ts:98`. Then enumerate their callers, including
    `cron/runner.ts:101`, `plugins/host/todos.ts:31` and `gateway/api.ts:3450`.
  - The guard learns scope from a resolver injected at boot. Its fallbacks: with no resolver,
    refuse only assignment into a `dedicated` project; treat an assignee not on the roster as
    unscoped; treat an unknown project id as `dedicated`.
  - Check entry points: `spawnSession` with a linked Todo, Dispatcher routing, and the
    board-walk projection (which skips).
  - Refuse the stranding transitions and name the holders: a project change, setting
    `dedicated`, and a scope-narrowing PATCH. This also enables `dedicated` writes.
  - The org and project scans report violations created by hand-edited YAML.
- [ ] T046 Apply FR-018 path checks to `publish_attachment`, path-based `attach_to_work_item`
  and the JSON `{path}` attachment route, for scoped callers only. Refuse `list_files` and
  `read_file`.
- [ ] T047 Write `mcp/project-profile.ts` and its resolver selection. The profile removes the
  refused tools, and always includes the note tools rooted at P, even when `notesEnabled` is
  off. Serve the note routes to scoped callers regardless of that flag (`gateway/api.ts:1207`).
  Set `JINN_PROJECT_ID` in scoped sessions' environment. Then:
  - write `sessions/context/project.ts`, covering the roster limited to members and the
    project section, and pay for its call site in `context.ts`;
  - add a lost-binding check to `refuseTurn`;
  - write an `escalated` event when a Todo leaves P;
  - apply the archived and unknown project spawn rules.
- [ ] T048 Tests (junior sub-Todo):
  - an allow and a refuse case for every table row, as a capability-bound scoped session
    against a seeded home;
  - 404 bodies identical to those for unknown ids;
  - `mayHoldTodo` at every writer and entry, covering `dedicated`, `@operator`, the
    fallbacks and the stranding refusals;
  - FR-009: a scoped caller can neither see nor message an unscoped session working a P Todo;
  - FR-013: a reply to `parent_session_id` succeeds, and other non-P sends are refused;
  - an emptied scope fails closed;
  - unscoped callers are unchanged by FR-018.

  Record the SC-002 one-off comparison in the PR.
- [ ] T049 [P] Web (junior sub-Todo):
  - org tree project badges and a project filter (FR-041);
  - the employee-editor scope control (`all` or a list, never empty);
  - the Projects page `dedicated` toggle, with the stranding refusal shown;
  - session badges in `SessionRow`, `mobile-session-row` and `TreeRow`;
  - the new-chat project picker for scoped employees with more than one project.

  Capture each in light and dark.

## Phase 3: scoped context (junior-developer, then senior QA; starts after Phase 2 merges)

- [ ] T060 Generate the stage dir at `<parent of home>/.jinn-projects/<id>/`. It contains
  copies of the allowed skills and a `CLAUDE.md` built from `INSTRUCTIONS.md`, plus the
  company file if `project+company` is set, plus the FR-029 scope paragraph. Regenerate it on
  skill, project-scan and instruction changes. Use it as cwd for scoped sessions in
  `engine-run.ts`. Write a trust seed for the stage dir when it is generated: the only seed
  today is the boot-time one at `gateway/server.ts:565`.
- [ ] T061 Make resume, fork and auto-compaction resolve the stage-dir transcript slug. Add a regression test for each.
- [ ] T062 Apply the skill allow-list to the copies, the prompt and `dispatchConfig.skills`.
- [ ] T063 Make `SEARCH_ROOTS` a parameter. For scoped callers:
  - root reads at `knowledge/projects/<id>/` (including `state.md`) plus `sharedNotes`;
  - refuse the company `knowledge/state.md`, `knowledge/employees/` and `docs/` unless they
    are shared;
  - allow note writes only in the project folder.
- [ ] T064 Update the template docs (`todo-handling`, `management`). Cover:
  - projects;
  - project state in `knowledge/projects/<id>/state.md`, kept through the note tools;
  - the fact that scoping is a guardrail, not a sandbox.

  Do not mention `mem`, which is instance-local. Add a migration note if instance files
  change.

## Follow-ups outside this feature

- [ ] F1 (senior-developer) Write the follow-up spec for employees on another Claude account,
  from spec.md "Follow-up". Its first task is the Keychain check.
- [ ] F2 (instance, not this repository) Make `~/.jinn/bin/mem` respect `JINN_PROJECT_ID`, so it
  defaults to `projects/<id>/state.md` and refuses other files.
