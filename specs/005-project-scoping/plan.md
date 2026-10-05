# Implementation Plan: Projects and Project-Scoped Employees

**Branch**: `feat/project-scoping-spec` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md. This plan assumes the recommended answer to every open question:

| Question | Assumed answer |
| --- | --- |
| Q1 | A for v1, with Phase 0 run alongside as an evaluation of B; Phase 4 only if Phase 0 passes and the operator confirms |
| Q2 | a |
| Q3 | a |
| Q4 | a |
| Q5 | project only |
| Q6 | a |
| Q7 | defer to Phase 4 |
| Q8 | a (base rule plus a per-project `dedicated` flag) |
| Q9 | off |
| Q10 | a under A; b if B or C is built |
| Q11 | only asked if Phase 0 item 10 fails |

Where a different answer changes the plan, the affected phase says how. In particular:

- **Q8-b:** every project behaves as `dedicated`. Phase 2 then needs a migration report of
  project Todos held by non-members, and the flag column is dropped.
- **Q8-c:** the `dedicated` flag and its checks drop out.
- **Q9-on:** scoped sessions keep `--chrome` and the user's connectors. T082 drops out, and
  E9 is removed from the escape script.
- **Q10-b:** FR-013 replies become a stored callback, which needs a new small store and UI
  surface. That is added to Phase 2 as its own task.
- **Q11-yes:** `gateway/server.ts:504` stops exporting the token, and the context
  section's `curl` fallback is removed. This is its own PR before Phase 4, because it changes
  every employee.
- **Q1-C:** Phase 4 is replaced by a separate spec for running scoped engines as a dedicated
  OS user.

## Existing infrastructure (constitution VII)

research.md carries the full table: data model, enforcement points, engine spawn, budgets, and
what was rejected. These are the rows this plan builds on. All are verified against `origin/main`
`60e675d6`.

| `path:line` | Used for |
| --- | --- |
| `packages/jinn/src/work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`, where the new tables are registered |
| `packages/jinn/src/work-items/sprints-schema.ts:60` | Root-membership filter, copied for `project` |
| `packages/jinn/src/gateway/sprints-api.ts:228` | Route-table module shape for `projects-api.ts` |
| `packages/jinn/src/gateway/api.ts:1181` | Identified-caller gate. The scoped-caller gate is one line beside it |
| `packages/jinn/src/gateway/remote-mcp/rules.ts:25` | Allow-list table shape for `project-scope/rules.ts` |
| `packages/jinn/src/gateway/remote-mcp/profile.ts:98` | Tool-profile filter shape for the scoped MCP profile |
| `packages/jinn/src/gateway/api.ts:2148` | `GET /api/work-items?ids=` returns Todos with no filter. The scoped read module must cover this branch |
| `packages/jinn/src/gateway/api.ts:1744` | `GET /api/sessions` `pinned` and `q` branches, also served by the scoped read module |
| `packages/jinn/src/work-items/store.ts:356` | `createWorkItem` insert: the first `assignee` writer |
| `packages/jinn/src/work-items/store.ts:797` / `:850` | The two update paths that call `releaseOnOwnerChange`, which the store calls "every writer of `assignee`" (`:961`). Between them, these three are the real choke point for FR-015 |
| `packages/jinn/src/gateway/api.ts:3450` | The delegation route creates a Todo already assigned |
| `packages/jinn/src/plugins/host/todos.ts:31` | A plugin creates with `draft.assignee` |
| `packages/jinn/src/gateway/api.ts:2409` | PATCH assignee branch, which does not go through `assignWorkItem` |
| `packages/jinn/src/gateway/spawn-session.ts:163` | Session binding (FR-008). The requester is the existing `parentSessionId` (`:188`) |
| `packages/jinn/src/gateway/todo-dispatch.ts:197` | Dispatcher entry point |
| `packages/jinn/src/gateway/api.ts:2925` | JSON `{path}` attachment ingestion (FR-018) |
| `packages/jinn/src/mcp/work-item-attachments.ts:68` | Path-based `attach_to_work_item` ingestion (FR-018) |
| `packages/jinn/src/mcp/file-tools.ts:96` | `publish_attachment` path (FR-018, Q6) |
| `packages/jinn/src/notes/store.ts:729` | `readKnowledgeFile`, which has no protected-entry check (Q6) |
| `packages/jinn/src/gateway/org.ts:170` | `WRITABLE_FIELDS`, which gains `projects` |
| `packages/jinn/src/sessions/turn/engine-run.ts:46` | cwd, which becomes the stage dir for scoped sessions |
| `packages/jinn/src/shared/child-env.ts:41` | Inherited environment. The allow-list builder sits beside it |
| `packages/jinn/src/engines/claude-interactive.ts:451` | Claude argv: `--chrome` at :451, `--dangerously-skip-permissions` at :454, `--settings` at :456, `--mcp-config` at :459 |
| `packages/jinn/src/gateway/auth.ts:250` | `authRequiredForRequest` exempt set (FR-025, E15) |
| `packages/jinn/src/gateway/server.ts:1035` | Upgrade handling: `/ws` and plugin events check auth only |
| `packages/jinn/assets/hook-relay.mjs:10` | The relay resolves its home from `JINN_HOME` (FR-025a) |
| `packages/jinn/src/board-walk/route-turn.ts:48` | `--no-chrome --strict-mcp-config` precedent |
| `packages/jinn/src/mcp/server-bootstrap.ts:25` | Capability derived from the key file. Skipped when one is passed |
| `packages/jinn/src/mcp/server.ts:39` | MCP server bearer fallback from `gateway.json`. It is how the MCP server authenticates when auth is on |
| `packages/jinn/src/gateway/request-handler.ts:55` | 401 gate when `authRequired`. FR-025 relies on it unchanged |
| `packages/jinn/src/sessions/turn/preflight.ts:52` | `refuseTurn`: lost binding, wrong engine |

## Summary

Each phase is its own PR off `main`, built in this order:

1. **Phase 0, containment evaluation.** Runs alongside Phases S to 3. Produces evidence, not product code. Decides whether Phase 4
   is buildable.
2. **Phase S, existing read gaps (Q6-a).** `read_knowledge` and `publish_attachment` go
   through the existing read policy.
3. **Phase 1, projects as a grouping.** Adds the tables and REST, Todo membership, the board
   filter and badge, the create and detail field, the Projects page, and the switcher.
   Nobody is restricted yet.
4. **Phase 2, scoped employees.** Adds:
   - explicit employee scope and session binding;
   - the scoped-caller gate with its scoped read module;
   - `mayHoldTodo` at every assignment path;
   - file-read limits;
   - the filtered MCP profile and the scoped roster;
   - the employee scope control, the new-chat project picker and session badges.
5. **Phase 3, scoped context.** Adds the stage dir outside the home, skill copies, Notes
   roots, and the instructions file.
6. **Phase 4, containment (Q1 = B).** Adds:
   - an allow-listed environment with secret references;
   - sandbox and deny rules in the gateway-written `--settings`;
   - `--no-chrome` and `--strict-mcp-config`;
   - a passed capability;
   - the `authRequired` precondition;
   - the escape script.

v1 (recommended Q1 = A) is Phases S, 1, 2 and 3, and the docs call scope a guardrail. Phase 4 is built only if Phase 0 passes and the operator confirms B.

## Technical Context

**Language/Version**: TypeScript on Node ≥ 22. The web app uses React 19, Vite and TanStack
Query 5.

**Primary Dependencies**: none new.

**Storage**:
- six additive registry tables and two added `sessions` columns (data-model.md);
- `projects` in org YAML;
- generated stage dirs outside the home.

**Testing**:
- vitest, with enforcement tests driving the real `handleApiRequest` as a capability-bound
  scoped session against a seeded temp home;
- Testing Library for web components;
- Playwright against a sandbox gateway for the light and dark evidence;
- the escape script, which runs real `claude -p` sessions.

**Constraints** (read from the tree):
- **The size ratchet is already red on `main`**: `node scripts/ratchet.mjs --check` reports
  "102 violations". Files this feature must touch that are already at or over budget:
  - `gateway/api.ts`: 4798 lines against a budget of 4803;
  - `mcp/server.ts`: 326 against 326;
  - `sessions/context.ts`: 1002 against 906;
  - `packages/web/src/lib/api.ts`: 876 against 876.

  The rule for this feature: **no file already at or over budget grows.**
  - `api.ts` takes four kinds of edit:
    - the gate line and the `projects-api.ts` mount;
    - create-time `project`, through a new `gateway/work-item-create-project.ts` called on one
      line, as `work-item-create-sprint.ts` is;
    - the list `project=` filter, which needs **no** `api.ts` edit because it is parsed in
      `gateway/work-item-query.ts`;
    - no edit for `mayHoldTodo`, which lives in the store.

    Every line spent in `api.ts` is paid for in the same PR by moving the `GET /api/sessions`
    handler (`gateway/api.ts:1743`, about 30 lines) into `gateway/sessions-list-api.ts`.
  - `context.ts` gets its project section from a new `sessions/context/project.ts`, and the
    call site is paid for by moving one existing section out.
- Scoped enforcement lives at the gate and in new modules (`gateway/project-scope/*`). No
  existing handler is edited for scoping:
  - per-id rows are checked at the gate, then fall through to the normal handler;
  - list and search rows for scoped callers are served by `project-scope/read-routes.ts`,
    which calls the same store functions with a `project` filter.
- The core manifest pi wrapper is at 4155 of 4156. FR-036 adds no parameter, and the scoped
  profile only removes tools.
- Privacy guard (`packages/jinn/src/shared/__tests__/privacy-guard.test.ts`): fixtures use
  invented names and paths.

## Constitution Check

| Principle | Status |
| --- | --- |
| I | Pass |
| II | Rung 4, justified in spec.md "Why This Matters". The spend ceiling reuses the existing per-employee cap |
| III | Every premise has a `path:line` in research.md. Phase 0 tests the containment premise before Phase 4. Phase S opens with a red test that `read_knowledge` returns `gateway.json` on `main` |
| IV | Rung 1 throughout. No new core tool. The manifest does not grow, which the attested hash checks. Under Q4-b it grows about 25 tokens, bought back in the same PR |
| V | Every table has a v1 consumer. No client layer, no per-project persona, no project cron, no budget key |
| VI | Enforcement tests assert allow and refuse outcomes. The route-enumeration test fails on a real defect, an unclassified route. **No snapshots**: the SC-002 `buildContext` and argv comparison is one-off PR evidence, not a committed fixture |
| VII | The table above sits ahead of the proposal. Re-verify it before each phase starts |
| VIII | Each refused class in the scoped table carries its reason, as `control-plane-routes.ts` does |

## Scoped-caller route table (FR-010)

**Who it applies to**: a capability-verified session whose employee is scoped. **P** is
`sessions.project_id`.

**Where it lives**: `packages/jinn/src/gateway/project-scope/rules.ts`.

**Default deny**: any unlisted route returns 403, "not available to a project-scoped session".

**Hiding other projects**: an out-of-project id returns the same 404 as an unknown id.

| Route(s) | Scoped behaviour | Where |
| --- | --- | --- |
| `GET /api/work-items` (both the `ids=` and query forms), `/api/work-items/trees`, `/api/search/work-items` | Only P's Todos. `ids=` drops non-P ids silently. A `project` other than P returns an empty page | read-routes |
| `POST /api/work-items` | Lands in P. A `project` other than P returns 403. A `parentId` outside P returns 404 | gate check, then handler |
| `GET/PATCH /api/work-items/:id`, `/status`, `/tree`, `/kept`, `/comments` (+ sub-routes), `/attachments` (multipart, + sub-routes) | Todo must be in P, otherwise 404. The existing standing rules then apply | gate |
| `POST /api/work-items/:id/attachments` with JSON `{path}` | As above, plus the FR-018 path check | gate |
| `GET /api/work-items/:id/sessions` | Todo in P. Lists only P-bound sessions, plus `hiddenCount` | read-routes |
| `POST /api/work-items/:id/assign`, `/dispatch`, `POST /api/delegations` | Todo in P. The target must be scoped to P (FR-016). `mayHoldTodo` also runs inside `assignWorkItem` | gate + core |
| `PATCH /api/work-items/:id` setting `assignee` | `mayHoldTodo` | store |
| `PUT /api/work-items/:id/dispatch-config` | Todo in P, and every skill must be on P's allow-list | gate |
| `/api/work-items/:id/relations` | Both ends in P. Reads report other relations as a hidden count | gate + read-routes |
| `POST /api/work-items/:id/capture-landing` (`land_on_work_item`) | Todo in P | gate |
| `PUT /api/work-items/:id/labels`, `GET /api/labels` | Existing labels only | gate |
| `PUT /api/work-items/:id/project`, `/sprint`, `/archive`, label create | Refused | — |
| `GET /api/sessions` (every branch), `/api/search/sessions`, `/api/search/messages`, message context | Only sessions bound to P | read-routes |
| `GET /api/sessions/:id` (+ `/messages`, `/children`, `/transcript`, `/context`) | Session must be bound to P, otherwise 404 | gate |
| `POST /api/sessions` (spawn) | Target scoped to P. The child is bound to P. A named parent must be bound to P | gate + `spawnSession` |
| `POST /api/sessions/:id/message` | Target bound to P, **or** the caller's own `parent_session_id` (FR-013, send only; delivery per Q10) | gate |
| `POST /api/sessions/:id/stop`, `POST /api/compactions` | Target bound to P. Stop is limited to own descendants, as today. Compaction is limited to own session | gate |
| `POST /api/sessions/:self/attachments` (`publish_attachment`) | Own session only. The FR-018 path check runs in the MCP tool | gate + tool |
| `GET /api/org`, `GET /api/org/employees/:name` | Members of P only. No departments. Anyone else returns 404 | read-routes |
| `GET /api/knowledge/search`, `/api/knowledge/read`, `GET /api/notes*`, `POST/PUT /api/notes` | Rooted per FR-028. Writes go only under the project folder | read-routes |
| Heartbeat routes | Own session only (as today) | gate |
| Engine-internal routes (`isPublicIdentifiedCallerRoute`, the hook endpoint, the status line) | Unchanged | — |
| WebSocket upgrades (`/ws`, `/ws/pty/:sessionId`, plugin events) | Refused for scoped callers. They are outside `handleApiRequest`, so the check sits in the upgrade guards (`gateway/upgrade-guards.ts`) | upgrade guard |
| **Everything else** | Refused. This covers config, cron, cost, connectors, files, `/api/search/global`, skills, sprints, departments, label admin, org writes, instances, engines, limits, board walk, talk control, onboarding, auth, logs and backup | — |

Phase 2's first task enumerates every route on `main`, the upgrade paths included, and
classifies each one. The enumeration test (SC-001) keeps the table complete from then on.

### `mayHoldTodo` (FR-015, Q8-a)

`project-scope/assignee.ts` defines `mayHoldTodo(employee, todoProject)`. It returns true when
any of these holds:

- the employee is `@operator`;
- the employee is scoped, and the Todo is in one of its projects;
- the employee is unscoped, or not on the roster, and the Todo is either company-level or in
  a project that is not `dedicated`.

If the store has no resolver, it refuses only assignment into a `dedicated` project.

**Where it is enforced:** at the store, in every writer of `assignee`:

- the `createWorkItem` insert (`work-items/store.ts:356`);
- the two `releaseOnOwnerChange` update paths (`work-items/store.ts:797`, `:850`).

The work-items layer does not know the roster. A resolver injected at gateway boot answers
"what is this employee's scope?" so the store can decide. That one store-level check covers
every caller:

- `assignWorkItem`, and with it the assign, delegation and talk paths;
- the PATCH assignee branch;
- the delegation create-already-assigned path (`gateway/api.ts:3450`);
- plugin creates (`plugins/host/todos.ts:31`);
- cron-created Todos (`cron/runner.ts:101`).

**Paths that start work without writing `assignee`** check it at their own entry:

- `spawnSession` with a linked Todo;
- Dispatcher routing;
- the board-walk projection, which skips the pairing rather than proposing it.

**Stranding transitions are refused, naming the holders** (FR-015):

- a project change;
- setting `dedicated`;
- a scope-narrowing `PATCH`.

A violation that comes from a hand edit to the YAML is reported by the org scan instead.

**First step of the task:** enumerate every `assignee` write in `work-items/store.ts`, and
every caller of those writers. Do not trust this list.

### Scoped MCP profile (FR-019)

`mcp/project-profile.ts` removes the tools whose routes are all refused:

- `list_cron_jobs`
- `get_cron_run_history`
- `cost_report`
- `send_connector_message`
- `list_files`
- `read_file`
- `list_departments`
- `create_label`
- `archive_work_item`

Unscoped manifests are unchanged, and the attested hash test proves it.

## Phases

### Phase 0: containment evaluation (senior-developer; time-boxed; alongside Phases S to 3)

No product code. It uses a throwaway sandbox gateway with `authRequired: true` and a
hand-built stage dir outside the home. It answers research.md "Containment" items 1–10 by
running the escape script E1–E15 by hand, and records the commands and their output under
"Phase 0 findings".

**Exit criterion**: E1–E15 all fail, the allowed actions succeed, and the exact settings,
argv, and environment allow-list are written down.

**On failure**: report to the operator with the failing items. v1 stays at A. If the operator still wants a boundary, C is the route, and Q11 is asked only if item 10 alone failed.

**Time-box**: one working session. Phase 0 is an evaluation, not a build.

### Phase S: existing read gaps (senior-developer; senior QA)

Routed to the senior because it is a secrets exposure, which is a named blast-radius trigger.

1. **Red tests first, on `main`:**
   - `GET /api/knowledge/read?path=gateway.json` returns the token;
   - the same for `secrets/mcp-session-capability.key`;
   - `publish_attachment` of a file under `secrets/` succeeds.
2. **Fix:** route `readKnowledgeFile` through `assessFileRead`, and `publish_attachment`
   through `readLocalFileForIngestion` (`shared/file-read-policy.ts`).
3. **Existing tests that change** (named in the PR):
   - `gateway/__tests__/knowledge-route.test.ts:155`, which expects `config.yaml` to be
     readable. Under Q6-a as recommended it becomes a refusal. If the operator keeps
     `config.yaml` readable, it stays.
   - `mcp/__tests__/knowledge-tools.test.ts:152` stays as it is. It is a stubbed test of the
     tool forwarding to the gateway, and the refusal happens in the gateway.

### Phase 1: projects as a grouping (junior-developer; junior QA)

This phase carries no auth or secret risk.

**Backend**
- `work-items/projects-schema.ts`, `projects.ts` and `project-membership.ts`.
- The list filter `project=<id>|none` in `store.ts`, next to sprint.
- Payload `project`.
- `gateway/projects-api.ts`. Writes are added to `control-plane-routes.ts` as operator-only.
- Config child tables for working directories (FR-033 validation), skills and shared Notes.
  `project_env` is not built here; it waits for Phase 4 (Q7).
- `company:changed {entity:"project"}`.

**Web**
- `lib/project-api.ts`.
- The `project` filter in the four `lib/todos.ts` places and the `use-board` key.
- A filter chip.
- Card Row 1 and list-row badges, using `deptHue`.
- A create `PropertyChip` and a rail row modelled on `sprint-rail-row.tsx`.
- The Projects page.
- The switcher, as a `statusbar.right` contribution and in the chat sidebar header.

**Visual**
- `scripts/verify-projects.sh`, a Playwright config, and a seed script following the
  chat-grid-drop pattern.
- Light and dark captures, attached to the PR with `gh pr comment --attach`.

### Phase 2: scoped employees (senior-developer; senior QA)

Routed to the senior because it is auth enforcement, a named blast-radius trigger. The
mechanical bulk, the per-row allow and refuse tests and the web pieces, goes to the junior as
separate Todos, specified from the route table and reviewed by the senior before QA.

- **Employee scope**: `projects` in `org.ts`, with explicit `all` versus a list (FR-007), the
  validation rules (claude-only, not system employees, `authRequired` under Q1 = B), and
  `WRITABLE_FIELDS`.
- **Sessions**: `sessions.project_id`, set in `spawnSession` by FR-008. The FR-013 requester is
  the existing `parent_session_id`. The badge for unscoped sessions is derived at read time.
- **Gateway modules**: `gateway/project-scope/{caller,rules,assignee,read-routes,paths}.ts`, the
  gate line, and the upgrade-guard check.
- **`mayHoldTodo`** at every call site listed above.
- **FR-018 path checks** in `publish_attachment`, path-based `attach_to_work_item`, and JSON
  attachment ingestion.
- **MCP profile and context**: `mcp/project-profile.ts`, `sessions/context/project.ts` (roster
  limited to members, a project section), and the `refuseTurn` lost-binding check.
- **Edge-case behaviour**:
  - an `escalated` event when a Todo leaves P under a live session;
  - hidden relation and session counts;
  - archived-project spawn rules;
  - cron validation refusing scoped targets;
  - connector-originated spawns refused for scoped employees.
- **Web**:
  - the employee-editor scope control (all, or a list, with no empty list);
  - the new-chat project picker for multi-project scoped employees;
  - session badges in `SessionRow`, `mobile-session-row` and `TreeRow`;
  - light and dark screenshots.
- **Tests**:
  - route enumeration;
  - allow and refuse for every row;
  - 404 bodies identical to an unknown id;
  - `mayHoldTodo` per call site;
  - FR-009, where a scoped caller cannot see or message an unscoped session on a P Todo;
  - FR-013, the reply to `parent_session_id` only;
  - FR-033, refusal of working directories that overlap the protected trees.

  SC-002 is checked by a one-off `buildContext` and argv comparison, recorded in the PR.

### Phase 3: scoped context (junior-developer; senior QA)

Senior QA because skill and Notes scoping is part of the boundary.

- **Stage dir** at `<parent of home>/.jinn-projects/<id>/`, regenerated on skill or project
  change. It contains the generated `CLAUDE.md` and **copies** of the allowed skills.
  `engine-run.ts` uses it as cwd for scoped sessions.
- **Transcript slugs**: Claude keys transcripts by cwd slug (`sessions/fork.ts:164`,
  `engines/claude-interactive.ts:271`). Resume, fork and auto-compaction must resolve the
  stage-dir slug, with a regression test for each. The stage-dir trust entry is seeded
  (`shared/claude-settings.ts:124`).
- **Skill allow-list** applied to the copies, the prompt and `dispatchConfig.skills`.
- **Notes**: `SEARCH_ROOTS` becomes a parameter, so scoped callers search the project folder
  plus its shared paths.
- **Instructions**: `INSTRUCTIONS.md` becomes the stage `CLAUDE.md`, honouring
  `instructions_mode`.
- **Docs**: template doc updates.

### Phase 4: containment (senior-developer; senior QA)

Built only if Phase 0 passes and the operator confirms B, using the Phase 0 findings.

- `project_env`: the table, the config route with names and `resolved` only, FR-031 name
  checks, and the Projects-page env section. Then an allow-list environment builder that
  resolves secret references at spawn. Values are never logged, and a test asserts it.
- Sandbox and deny rules, `allowUnsandboxedCommands: false`, and stage-dir write denies, all in
  the gateway-written `--settings` file under `tmp/`.
- `--no-chrome` and `--strict-mcp-config` for scoped sessions, plus the connector and
  user-MCP exclusion mechanism Phase 0 found.
- `server-bootstrap.ts` stops deriving a capability when the environment already carries one
  (FR-024). Today the derived value wins at `mcp/server.ts:291`.
- Validation refusing scoped employees when `authRequired` is off.
- The hook relay taking its home, URL and credential on argv (FR-025a). FR-033 already shipped in Phase 1.
- `scripts/verify-project-containment.sh` (E1–E15), with its output attached to the PR.

## Delegation split

| Phase | Producer | Reviewer | Trigger |
| --- | --- | --- | --- |
| 0 | senior | senior QA | Ambiguity in engine behaviour (runs alongside Phases S to 3) |
| S | senior | senior QA | Secrets exposure |
| 1 | junior | junior QA | Fully specified, no auth or secrets |
| 2 | senior, with junior sub-Todos for the test matrix and web | senior QA | Auth enforcement |
| 3 | junior | senior QA | Specified. Part of the boundary, so senior review |
| 4 | senior | senior QA | Spawn infrastructure, the boundary itself |

## Complexity Tracking

| Item | Why | Simpler alternative rejected because |
| --- | --- | --- |
| Five tables in v1 (`project_env` is the sixth, in Phase 4) rather than one with a JSON config | Each list is validated on its own: working directories against FR-033, skills against `skills/`, and in Phase 4 env names against FR-031 and the secrets store | A JSON column escapes the boot data check, and invites values where names belong |
| A second route table beside the connector's | The scoped principal differs from the connector in almost every row | One table with a principal column is harder to audit |
| A scoped read module rather than filters inside handlers | Handlers are over budget, and several have unfiltered branches (`ids=`, `pinned`, `q`) | Threading `project` through each branch of each handler is where a missed branch leaks |
| A stage dir outside the home, with copied skills | Ancestor `CLAUDE.md` loading, and symlinks into a denied tree | A prompt-only skill restriction is not a restriction |
