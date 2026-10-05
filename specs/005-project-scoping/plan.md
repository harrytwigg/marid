# Implementation Plan: Projects and Project-Scoped Employees

**Branch**: `feat/project-scoping-spec` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md. This plan assumes the recommended answer to every open question:

| Question | Assumed answer |
| --- | --- |
| Q1 | B |
| Q2 | a |
| Q3 | a |
| Q4 | a |
| Q5 | project only |
| Q6 | a |
| Q7 | yes |
| Q8 | a |
| Q9 | off |

Where a different answer changes the plan, the affected phase says how.

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
| `packages/jinn/src/work-items/assignment.ts:77` | `assignWorkItem`: the single choke point for FR-015 |
| `packages/jinn/src/gateway/api.ts:2409` | PATCH assignee branch, which does not go through `assignWorkItem` |
| `packages/jinn/src/gateway/spawn-session.ts:163` | Session binding (FR-008) and requester record (FR-013) |
| `packages/jinn/src/gateway/todo-dispatch.ts:197` | Dispatcher entry point |
| `packages/jinn/src/gateway/api.ts:2925` | JSON `{path}` attachment ingestion (FR-018) |
| `packages/jinn/src/mcp/work-item-attachments.ts:68` | Path-based `attach_to_work_item` ingestion (FR-018) |
| `packages/jinn/src/mcp/file-tools.ts:96` | `publish_attachment` path (FR-018, Q6) |
| `packages/jinn/src/notes/store.ts:729` | `readKnowledgeFile`, which has no protected-entry check (Q6) |
| `packages/jinn/src/gateway/org.ts:170` | `WRITABLE_FIELDS`, which gains `projects` |
| `packages/jinn/src/sessions/turn/engine-run.ts:46` | cwd, which becomes the stage dir for scoped sessions |
| `packages/jinn/src/shared/child-env.ts:41` | Inherited environment. The allow-list builder sits beside it |
| `packages/jinn/src/engines/claude-interactive.ts:451` | Claude argv: `--chrome` at :452, `--settings` at :456, `--mcp-config` at :459 |
| `packages/jinn/src/board-walk/route-turn.ts:48` | `--no-chrome --strict-mcp-config` precedent |
| `packages/jinn/src/mcp/server-bootstrap.ts:25` | Capability derived from the key file. Skipped when one is passed |
| `packages/jinn/src/mcp/server.ts:39` | MCP server bearer fallback from `gateway.json`. It is how the MCP server authenticates when auth is on |
| `packages/jinn/src/gateway/request-handler.ts:55` | 401 gate when `authRequired`. FR-025 relies on it unchanged |
| `packages/jinn/src/sessions/turn/preflight.ts:52` | `refuseTurn`: lost binding, wrong engine |

## Summary

Each phase is its own PR off `main`, built in this order:

1. **Phase 0, containment spike.** Produces evidence, not product code. Decides whether Phase 4
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

Under Q1 = A, Phases 0 and 4 drop out, and the docs call scope a guardrail.

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
  - `api.ts` gets only the gate line and the `projects-api.ts` mount. Lines spent there are
    recovered in the same PR by moving an existing handler out.
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
| `PATCH /api/work-items/:id` setting `assignee` | `mayHoldTodo` | core (the PATCH branch) |
| `PUT /api/work-items/:id/dispatch-config` | Todo in P, and every skill must be on P's allow-list | gate |
| `/api/work-items/:id/relations` | Both ends in P. Reads report other relations as a hidden count | gate + read-routes |
| `POST /api/work-items/:id/capture-landing` (`land_on_work_item`) | Todo in P | gate |
| `PUT /api/work-items/:id/labels`, `GET /api/labels` | Existing labels only | gate |
| `PUT /api/work-items/:id/project`, `/sprint`, `/archive`, label create | Refused | — |
| `GET /api/sessions` (every branch), `/api/search/sessions`, `/api/search/messages`, message context | Only sessions bound to P | read-routes |
| `GET /api/sessions/:id` (+ `/messages`, `/children`, `/transcript`, `/context`) | Session must be bound to P, otherwise 404 | gate |
| `POST /api/sessions` (spawn) | Target scoped to P. The child is bound to P and records its requester. A named parent must be bound to P | gate + `spawnSession` |
| `POST /api/sessions/:id/message` | Target bound to P, **or** the caller's own recorded requester (FR-013, send only) | gate |
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

`project-scope/assignee.ts`: `mayHoldTodo(employee, todoProject)` holds when one of these is
true:

- the Todo is in a project and the employee's scope includes that project;
- the Todo is company-level and the employee is unscoped.

It is called from:

- inside `assignWorkItem` (`work-items/assignment.ts:77`), which covers `gateway/api.ts:2650`,
  `gateway/api.ts:3501`, `talk/control/todo-adapters.ts:132` and `talk/control/delegation-adapter.ts:107`;
- the PATCH assignee branch (`gateway/api.ts:2409`);
- `spawnSession` with a linked Todo;
- Dispatcher routing;
- the board-walk projection, which skips the pairing rather than proposing it.

Phase 2 re-derives this list by enumerating callers of `assignWorkItem`, and every write of
`patch.assignee`, before relying on it.

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

### Phase 0: containment spike (senior-developer, Q1 = B only)

No product code. It uses a throwaway sandbox gateway with `authRequired: true` and a
hand-built stage dir outside the home. It answers research.md "Containment" items 1–9 by
running the escape script E1–E9 by hand, and records the commands and their output under
"Phase 0 findings".

**Exit criterion**: E1–E9 all fail, the allowed actions succeed, and the exact settings,
argv, and environment allow-list are written down.

**On failure**: report to the operator. Phase 4 drops, and Q1 falls back to A.

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
- Config child tables, with the env names checked against FR-031. The API returns names and
  `resolved` only.
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
- **Sessions**: `sessions.project_id` and `sessions.requester_session_id`, both set in
  `spawnSession` by FR-008. The badge for unscoped sessions is derived at read time.
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
  - FR-013, the requester reply.

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

Built only under Q1 = B, from the Phase 0 findings.

- An allow-list environment builder, with secret references resolved at spawn. Values are
  never logged, which a test asserts.
- Sandbox and deny rules, `allowUnsandboxedCommands: false`, and stage-dir write denies, all in
  the gateway-written `--settings` file under `tmp/`.
- `--no-chrome` and `--strict-mcp-config` for scoped sessions, plus the connector and
  user-MCP exclusion mechanism Phase 0 found.
- The capability passed on the jinn MCP server's environment. `server-bootstrap.ts` derives
  one only when none is passed.
- Validation refusing scoped employees when `authRequired` is off.
- `scripts/verify-project-containment.sh` (E1–E9), with its output attached to the PR.

## Delegation split

| Phase | Producer | Reviewer | Trigger |
| --- | --- | --- | --- |
| 0 | senior | senior QA | Ambiguity in engine behaviour |
| S | senior | senior QA | Secrets exposure |
| 1 | junior | junior QA | Fully specified, no auth or secrets |
| 2 | senior, with junior sub-Todos for the test matrix and web | senior QA | Auth enforcement |
| 3 | junior | senior QA | Specified. Part of the boundary, so senior review |
| 4 | senior | senior QA | Spawn infrastructure, the boundary itself |

## Complexity Tracking

| Item | Why | Simpler alternative rejected because |
| --- | --- | --- |
| Six tables rather than one with a JSON config | Each list is validated on its own: skills against `skills/`, env names against FR-031 and `secrets/` | A JSON column escapes the boot data check, and invites values where names belong |
| A second route table beside the connector's | The scoped principal differs from the connector in almost every row | One table with a principal column is harder to audit |
| A scoped read module rather than filters inside handlers | Handlers are over budget, and several have unfiltered branches (`ids=`, `pinned`, `q`) | Threading `project` through each branch of each handler is where a missed branch leaks |
| A stage dir outside the home, with copied skills | Ancestor `CLAUDE.md` loading, and symlinks into a denied tree | A prompt-only skill restriction is not a restriction |
