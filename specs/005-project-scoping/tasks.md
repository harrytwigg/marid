# Tasks: Projects and Project-Scoped Employees

**Status: provisional.** These tasks assume the recommended answer to every question in
spec.md. They are re-cut once the operator has answered, and no task starts before then.

Each phase is a separate PR off `main`. A phase starts only after the previous phase's PR has
merged.

Every task follows these rules:

- Re-verify the plan's `path:line` rows for your phase before starting (Principle VII).
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` locally. The repo has no CI
  at the moment, so say in the PR that verification was local.
- Keep within the size ratchets (`size-baseline.json`).

`[P]` marks a task that can run in parallel with others in its phase.

## Phase 0: containment spike (senior-developer; only under Q1 = B)

- [ ] T001 Set up a throwaway sandbox gateway on a port ≥ 8060, a scoped test employee, and a
  hand-built stage dir with `.claude/settings.json` sandbox and deny blocks.
- [ ] T002 Answer research.md Containment items 1–6 with real `claude -p` runs. Record the
  commands and their output in research.md under "Phase 0 findings".
- [ ] T003 Run the US3 escape script by hand: every escape fails and every allowed action
  succeeds. Record the exact settings and environment allow-list that achieve it.
- [ ] T004 Report go or no-go to the operator. On no-go, mark Phase 4 dropped and amend
  spec.md (Q1 → A).

## Phase S: existing security gaps (junior-developer → senior QA)

- [ ] T010 Write a red test: `GET /api/knowledge/read?path=secrets/<key file>` returns the
  content on `main`. Write the same for `publish_attachment` given a path under `secrets/`.
- [ ] T011 Apply `shared/protected-home-entries.ts` in `notes/store.ts` `readKnowledgeFile`
  and in `mcp/file-tools.ts` `publish_attachment`. Update the two tests that assert the gap
  (`gateway/__tests__/knowledge-route.test.ts:155`,
  `mcp/__tests__/knowledge-tools.test.ts:152`). Leave `config.yaml` readable unless the
  operator decides otherwise in review.

## Phase 1: projects as a grouping (junior-developer → senior QA)

**Backend**

- [ ] T020 Write `work-items/projects-schema.ts` with the tables from data-model.md.
  Register them in `V2_ADDITIVE_TABLES` and `REQUIRED_TABLE_SQL`, and add the
  root-only boot data check.
- [ ] T021 Write `work-items/projects.ts` (create, get, list, update, archive, unarchive, and
  the reserved names) and `work-items/project-membership.ts` (root-only move with a
  `project_changed` event, plus a batch ref read).
- [ ] T022 Add the `project` list filter (`id|none`) in `store.ts`, payload `project` on the
  compact and detail wires, `project` on the create path, and `project` in the create
  idempotency hash only when set (as sprint does).
- [ ] T023 Write `gateway/projects-api.ts` with the plan's routes, and mount it in `api.ts`
  (one line). Writes are operator-only, added to `control-plane-routes.ts`. Add the
  `company:changed {entity:"project"}` payload and guard in `packages/gateway-events`.
- [ ] T024 Add project config routes for working directories (absolute and realpath),
  skills (must exist under `skills/`), shared Notes (relative, under `knowledge/` or `docs/`)
  and env (names only). The API never returns a secret value.
- [ ] T025 Tests:
  - filter semantics (`none`, unknown id, archived);
  - root-only membership;
  - sub-task inheritance;
  - archive refusals;
  - name rules;
  - env API leaks no value (seed a secret and assert it does not appear in any response
    body).

**Web**

- [ ] T026 [P] Write `lib/project-api.ts` and `hooks/use-projects.ts`, and add
  query-invalidation wiring.
- [ ] T027 [P] Board: add the project filter in the four `lib/todos.ts` places and the
  `use-board` key, plus the filter chip, the card badge (Row 1) and the list-row badge.
- [ ] T028 [P] Add the create dialog `PropertyChip` and a detail rail row modelled on
  `sprint-rail-row.tsx`.
- [ ] T029 [P] Build the Projects page: route, nav entry, talk coverage entry, and
  `PageScaffold` sections for details, working directories, skills, shared Notes, env names
  with resolved status, members (read-only here), and archive.
- [ ] T030 [P] Build the project switcher as a status bar contribution and as a control in the
  chat sidebar header. It drives the board filter and the sidebar list.
- [ ] T031 Write the visual verification: `scripts/verify-projects.sh`,
  `playwright.projects.config.ts` and a seed script. Capture light and dark for T027–T030 and
  attach them to the PR.

## Phase 2: scoped employees (junior-developer → senior QA)

- [ ] T040 Enumerate every route on `main` and classify each one against the plan's table.
  Write the route-enumeration test that fails on any unclassified route.
- [ ] T041 Employee `projects`:
  - read in `org.ts`, into `Employee`;
  - validation: an unknown id means scoped to nothing, scoped employees are claude-only, and
    system employees cannot be scoped;
  - add to `WRITABLE_FIELDS`, and add to the web `Employee` and `EmployeeUpdate` types.
- [ ] T042 Add `sessions.project_id` with its index, and set the binding in `spawnSession`
  using the FR-008 order. Refuse a spawn when no project resolves.
- [ ] T043 Write `gateway/project-scope/caller.ts` (`scopeFor`) and `rules.ts` (the table),
  and add the gate call beside `gateway/api.ts:1181`.
- [ ] T044 Add per-route filtering and 404s for the Todo, session, org and knowledge rows, all
  through `scopeFor`.
- [ ] T045 Write `project-scope/assignee.ts` (`mayHoldTodo`). Call it on assign, delegate,
  dispatch, the board walk projection, Shaper routing and create-with-assignee.
- [ ] T046 Write `mcp/project-profile.ts` and the resolver selection.
- [ ] T047 `buildContext`: roster limited to members, and a project section. `refuseTurn`:
  refuse on a lost binding.
- [ ] T048 Tests:
  - allow and refuse for every table row, as a capability-bound scoped session against a
    seeded home with company Todos and Todos in two projects;
  - 404 bodies identical to an unknown id;
  - assignee checks per path;
  - SC-002 equality for an unscoped roster (manifest, `buildContext` and argv against
    fixtures generated from `main`).
- [ ] T049 [P] Web: the employee-editor scope control, and session badges in `SessionRow`,
  `mobile-session-row` and session-tree `TreeRow`. Capture light and dark screenshots.

## Phase 3: scoped context (junior-developer → senior QA)

- [ ] T060 Generate and regenerate the stage dir (data-model.md), and use it as cwd for
  scoped sessions in `engine-run.ts`. Seed the stage-dir trust entry.
- [ ] T061 Make resume, fork and auto-compaction resolve the stage-dir transcript slug. Write
  regression tests for each.
- [ ] T062 Apply the skill allow-list to the links, the prompt and `dispatchConfig.skills`.
- [ ] T063 Make `SEARCH_ROOTS` a parameter. Root scoped callers at the project folder plus
  its shared paths, and limit note writes to the project folder.
- [ ] T064 Write `INSTRUCTIONS.md` to the stage `CLAUDE.md`, honouring `instructions_mode`.
  Update the template docs for projects in `todo-handling` and `management`, and add a
  migration note if any instance files change.

## Phase 4: containment (senior-developer → senior QA; Q1 = B)

- [ ] T080 Write an allow-list environment builder for scoped sessions, with secret
  references resolved at spawn. Test that values never appear in logs, events or API
  responses.
- [ ] T081 Add the sandbox and `permissions.deny` blocks to scoped session settings, as Phase
  0 established.
- [ ] T082 Pass the capability on the MCP server environment. Make `server-bootstrap.ts`
  derive it only when none was passed. Test that a contained shell cannot mint one.
- [ ] T083 Refuse unauthenticated requests from contained sessions, using the mechanism from
  Phase 0. Gateway auth changes only with the operator's approval.
- [ ] T084 Write `scripts/verify-project-containment.sh`, the escape script against a sandbox
  gateway, and attach its output to the PR.
