# Tasks: Projects and Project-Scoped Employees

**Status: provisional.** These tasks assume the recommended answer to each of Q1–Q9 in
spec.md. They are re-cut after the operator answers, and no task starts before then.

**How phases ship.** Each phase is its own PR off `main`, and a phase starts only after the
previous phase has merged.

**Rules for every phase.**

- Re-verify the plan's `path:line` rows before starting.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` locally. The repo has no
  running CI, so say in the PR that verification was local.
- Do not grow any file that is at or over its size budget. The ratchet is already red on
  `main`, so compare only the files you touch.

**Legend.** `[P]` marks a task that can run in parallel within its phase. The producer and
reviewer for each phase are in plan.md, "Delegation split".

## Phase 0: containment spike (senior-developer → senior QA; only under Q1 = B)

- [ ] T001 Set up a throwaway sandbox gateway on a port ≥ 8060 with `authRequired: true`, plus
  a scoped test employee and a hand-built stage dir outside the home. Launch the session with
  the gateway's own argv and a hand-written `--settings` file.
- [ ] T002 Answer research.md "Containment" items 1–9 with real `claude -p` runs. Record
  commands and output under "Phase 0 findings".
- [ ] T003 Run E1–E9 and the allowed actions by hand. Record the exact settings, argv and
  environment allow-list that make them pass.
- [ ] T004 Report go or no-go to the operator. On no-go, mark Phase 4 dropped and amend
  spec.md (Q1 → A).

## Phase S: existing read gaps (senior-developer → senior QA)

- [ ] T010 Write the red tests on `main`:
  - `GET /api/knowledge/read?path=gateway.json` returns the token;
  - the same route returns the capability key;
  - `publish_attachment` of a path under the secrets directory succeeds.
- [ ] T011 Route `readKnowledgeFile` through `assessFileRead` and `publish_attachment` through
  `readLocalFileForIngestion` (`shared/file-read-policy.ts`).
  - Update `gateway/__tests__/knowledge-route.test.ts:155`, where `config.yaml` becomes
    refused, unless the operator keeps it readable.
  - Name every changed test in the PR.

## Phase 1: projects as a grouping (junior-developer → junior QA)

- [ ] T020 Write `work-items/projects-schema.ts` with the data-model tables. Register them in
  `V2_ADDITIVE_TABLES` and `REQUIRED_TABLE_SQL`, and add the root-only boot data check.
- [ ] T021 Write `work-items/projects.ts` (CRUD, archive/unarchive, reserved names) and
  `work-items/project-membership.ts` (root-only move, `project_changed` event, batch ref read).
- [ ] T022 Wire `project` into Todos:
  - the list filter `project=<id>|none` in `store.ts`;
  - the `project` payload on the compact and detail wires;
  - create-time `project`;
  - inheritance from the parent on `parentId` creates (FR-036);
  - the idempotency hash, only when `project` is set.
- [ ] T023 Write `gateway/projects-api.ts` and mount it with one line in `api.ts`, paid for
  by moving code out of `api.ts`. Add the write routes to `control-plane-routes.ts`. Add the
  `company:changed {entity:"project"}` payload and guard in `packages/gateway-events`.
- [ ] T024 Add the config routes:
  - working directories (absolute, stored as realpath);
  - skills (each must exist);
  - shared Notes (relative, under `knowledge/` or `docs/`);
  - env (names checked against the FR-031 reserved set; responses return names and
    `resolved` only).
- [ ] T025 Tests:
  - filter semantics (`none`, an unknown id, an archived project);
  - root-only membership and sub-task inheritance;
  - archive refusals and the name rules;
  - FR-031 refusals;
  - a seeded secret value appears in no response body.
- [ ] T026 [P] Web: `lib/project-api.ts`, `hooks/use-projects.ts`, and query invalidation.
- [ ] T027 [P] Board: the project filter in the four `lib/todos.ts` places and the `use-board`
  key, plus a filter chip, a card Row 1 badge and a list-row badge.
- [ ] T028 [P] The project `PropertyChip` in the create dialog, and a detail rail row
  modelled on `sprint-rail-row.tsx`.
- [ ] T029 [P] The Projects page: route, nav, talk coverage, and `PageScaffold` sections for
  details, working directories, skills, shared Notes, env names with resolved state, members
  (read-only) and archive.
- [ ] T030 [P] The project switcher: a status bar contribution plus the chat sidebar header.
  It drives the board filter and the sidebar list.
- [ ] T031 Visual tests: `scripts/verify-projects.sh`, `playwright.projects.config.ts` and a
  seed script. Capture T027–T030 in light and dark, and attach the captures to the PR.

## Phase 2: scoped employees (senior-developer → senior QA; T048 and T049 go to the junior as their own Todos)

- [ ] T040 Enumerate every API route on `main` and every WebSocket upgrade path, and classify
  each against the plan's table. Write the route-enumeration test, which fails on any
  unclassified route.
- [ ] T041 Explicit employee scope (FR-007):
  - YAML `projects` → `projectScope: "all" | string[]`, failing closed when the list is empty
    or unknown;
  - validation: claude-only, no system employees, `authRequired` under Q1 = B, no cron job
    targeting a scoped employee;
  - `WRITABLE_FIELDS`, with PATCH refusing an empty list;
  - the web `Employee` and `EmployeeUpdate` types.
- [ ] T042 Add `sessions.project_id` and `sessions.requester_session_id`, set only for scoped
  employees in `spawnSession` by FR-008. A scope mismatch, a company Todo, or a conflicting
  explicit project refuses the spawn. Refuse connector-originated sessions for scoped
  employees.
- [ ] T043 Write `gateway/project-scope/{caller,rules,paths}.ts`. Add the gate line beside
  `gateway/api.ts:1181`, and the scoped check in `gateway/upgrade-guards.ts`.
- [ ] T044 Write `gateway/project-scope/read-routes.ts`. It serves every scoped list and search
  row, including the `ids=`, `pinned` and `q` branches, the session-list `hiddenCount`, and
  the relation hidden count. It calls the store functions with a `project` filter, and no
  existing handler is edited.
- [ ] T045 Write `gateway/project-scope/assignee.ts` (`mayHoldTodo`). First enumerate the
  callers of `assignWorkItem` and every write of `patch.assignee`. Then call it inside
  `assignWorkItem`, in the PATCH assignee branch, in `spawnSession` with a linked Todo, in
  Dispatcher routing, and in the board-walk projection (which skips the Todo).
- [ ] T046 Add the FR-018 path checks: `publish_attachment`, path-based
  `attach_to_work_item`, and the JSON `{path}` attachment route. Refuse `list_files` and
  `read_file`.
- [ ] T047 Write `mcp/project-profile.ts` and the resolver selection, and
  `sessions/context/project.ts` (member roster and project section; pay for the call site in
  `context.ts`). Add the `refuseTurn` lost-binding check. Write an `escalated` event when a
  Todo leaves P under a live scoped session. Apply the archived-project spawn rule.
- [ ] T048 Tests (junior sub-Todo, from the table):
  - allow and refuse for every row;
  - 404 bodies identical to an unknown id;
  - `mayHoldTodo` at each call site;
  - FR-009: a scoped caller cannot see or message an unscoped session working a P Todo;
  - FR-013: the requester reply succeeds, and sending to any other non-P session is
    refused;
  - an emptied scope fails closed.
  Record the SC-002 one-off `buildContext` and argv comparison in the PR, not as a committed
  fixture.
- [ ] T049 [P] Web (junior sub-Todo): the employee-editor scope control (all, or a list, with
  no empty list), the new-chat project picker for multi-project scoped employees, and session
  badges in `SessionRow`, `mobile-session-row` and session-tree `TreeRow`. Capture light and
  dark screenshots.

## Phase 3: scoped context (junior-developer → senior QA)

- [ ] T060 Generate the stage dir at `<parent of home>/.jinn-projects/<id>/`, with copies of
  the allowed skills and the generated `CLAUDE.md`. Regenerate it on skill and project
  changes. Use it as the cwd for scoped sessions in `engine-run.ts`, and seed its trust entry.
- [ ] T061 Make resume, fork and auto-compaction resolve the stage-dir transcript slug, with
  a regression test for each.
- [ ] T062 Apply the skill allow-list to the copies, the prompt and `dispatchConfig.skills`.
- [ ] T063 Make `SEARCH_ROOTS` a parameter. For scoped callers, root reads at the project
  folder plus its shared paths, and allow note writes only in the project folder.
- [ ] T064 Write `INSTRUCTIONS.md` into the stage `CLAUDE.md`, following
  `instructions_mode`. Update the template docs (`todo-handling`, `management`), and add a
  migration note if instance files change.

## Phase 4: containment (senior-developer → senior QA; Q1 = B)

- [ ] T080 Build the allow-list environment for scoped sessions, with secret references
  resolved at spawn. Test that no value appears in logs, events or API responses.
- [ ] T081 Put the sandbox and deny rules, `allowUnsandboxedCommands: false`, and the
  stage-dir write denies in the gateway-written `--settings`, as Phase 0 established.
- [ ] T082 Pass `--no-chrome` and `--strict-mcp-config` for scoped sessions, plus the
  connector and user-level MCP exclusion Phase 0 found.
- [ ] T083 Pass the capability on the jinn MCP server's environment. `server-bootstrap.ts`
  derives it only when none is passed.
- [ ] T084 Write `scripts/verify-project-containment.sh` (E1–E9) against a sandbox gateway,
  and attach its output to the PR.
