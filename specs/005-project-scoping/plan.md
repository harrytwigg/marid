# Implementation Plan: Projects and Project-Scoped Employees

**Branch**: `feat/project-scoping-spec` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md. This plan assumes each open question's recommended answer:

| Question | Assumed answer |
| --- | --- |
| Q1 | B |
| Q2 | a |
| Q3 | a |
| Q4 | a |
| Q5 | project only |
| Q6 | a |
| Q7 | yes |

Where a different answer changes the plan, the phase says how.

## Summary

The work splits into five changes, each its own PR off `main` in this order:

1. **Phase 0, the containment spike.** It produces evidence, not product code. It decides
   whether Phase 4 is buildable.
2. **Phase S, the security gaps that exist today (Q6-a).** `read_knowledge` and
   `publish_attachment` get the protected-home policy.
3. **Phase 1, projects as a grouping.** Tables, REST, Todo membership, the board filter and
   badge, the create and detail field, the Projects page, and the switcher. It restricts nobody.
4. **Phase 2, scoped employees.** Employee `projects`, session binding, the scoped-caller route
   gate, per-route filtering, assignee checks on every assignment path, a filtered MCP profile,
   and a scoped prompt roster. The employee scope control and session badges come with it.
5. **Phase 3, scoped context, then Phase 4, containment (Q1 = B).**
   - Phase 3 adds the project stage dir as the session cwd, the skill allow-list, the Notes
     roots and the instructions file.
   - Phase 4 adds the allow-listed environment with secret references, sandbox and deny rules,
     the capability passed rather than derived, the unauthenticated-request refusal, and the
     escape script as an end-to-end test.

Under Q1 = A, Phase 0 and Phase 4 are dropped, and the docs call scope a guardrail.

## Existing infrastructure (constitution VII)

research.md carries the full table: data model, enforcement points, engine spawn, budgets, and
what was rejected. The rows this plan builds on most directly:

| `path:line` | Used for |
| --- | --- |
| `packages/jinn/src/work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`: the new tables are registered here |
| `packages/jinn/src/work-items/sprints-schema.ts:60` | The root-membership filter shape copied for `project` |
| `packages/jinn/src/gateway/sprints-api.ts:228` | Route-table module shape copied for `projects-api.ts` |
| `packages/jinn/src/gateway/api.ts:1181` | The identified-caller gate. The scoped-caller gate is one line beside it |
| `packages/jinn/src/gateway/remote-mcp/rules.ts:25` | Allow-list table shape copied for `project-scope/rules.ts` |
| `packages/jinn/src/gateway/remote-mcp/profile.ts:98` | Tool-profile filter shape copied for the scoped MCP profile |
| `packages/jinn/src/gateway/spawn-session.ts:163` | Session binding (FR-008) |
| `packages/jinn/src/gateway/todo-dispatch.ts:197` | Assignee-scope check for dispatch and board walk |
| `packages/jinn/src/gateway/org.ts:170` | `WRITABLE_FIELDS` gains `projects` |
| `packages/jinn/src/sessions/turn/engine-run.ts:46` | cwd becomes the stage dir for scoped sessions |
| `packages/jinn/src/shared/child-env.ts:41` | Allow-list environment builder beside it |
| `packages/jinn/src/shared/claude-settings.ts:70` | Sandbox and deny rules for scoped sessions |
| `packages/jinn/src/mcp/server-bootstrap.ts:25` | Stop deriving when the gateway passed a capability |
| `packages/jinn/src/notes/store.ts:613` | `SEARCH_ROOTS` becomes a parameter |
| `packages/jinn/src/sessions/turn/preflight.ts:52` | `refuseTurn`: lost binding, wrong engine |

## Technical Context

**Language/Version**: TypeScript on Node ≥ 22. The web app is React 19, Vite and TanStack
Query 5.

**Primary Dependencies**: none new.

**Storage**:
- six additive registry tables and one added `sessions` column (data-model.md);
- `projects` on org YAML;
- generated stage dirs.

**Testing**:
- vitest. Enforcement tests drive the real `handleApiRequest` as a capability-bound scoped
  session, against a seeded temp home.
- Web component tests use Testing Library.
- Playwright against a sandbox gateway gives the light/dark evidence.
- The Phase 4 escape script runs real `claude -p` sessions.

**Constraints** (read from the tree, research.md "Budgets"):
- `gateway/api.ts` has 5 lines of size budget left. It gains only a mount line for
  `projects-api.ts` and the gate call. All logic goes in new modules.
- `mcp/server.ts` is exactly at budget. The scoped profile filter lives in
  `mcp/project-profile.ts`, and the line that applies it is paid for in the same diff.
- `packages/web/src/lib/api.ts` is at budget. Project calls and types go in
  `lib/project-api.ts`.
- The core manifest pi wrapper is at 4155 of 4156. FR-036 adds no parameter. The scoped
  profile only removes tools.
- The privacy guard (`packages/jinn/src/shared/__tests__/privacy-guard.test.ts`): fixtures use
  invented names and paths.

## Constitution Check

| Principle | Status |
| --- | --- |
| I. No upstream | Pass. Built for this fork, with no upstream PR |
| II. Direction | Rung 4, justified in spec.md "Why This Matters". It is the stated ceiling that unattended project work needs |
| III. Verify the premise | Each premise has a `path:line` in research.md. Phase 0 tests the containment premise before Phase 4 builds on it, and Phase S starts with a red test showing `read_knowledge` returning `secrets/` content on `main` |
| IV. Footprint Ladder | Rung 1 throughout: existing routes, tables and tools gain a dimension. No new core MCP tool, and the manifest does not grow (Q4-a). Under Q4-b this becomes a rung-1 manifest growth of about 20 tokens, bought back in the same PR |
| V. No speculative infrastructure | Each table has a consumer in v1. Nothing is reserved for a client layer, and there is no per-project persona or project-owned cron |
| VI. Tests that can fail | Enforcement tests assert allow and refuse outcomes, not shapes. The route-enumeration test fails on an unclassified route, which is a real defect, not a change detector. No snapshots: the screenshots are PR evidence, not assertions |
| VII. `file:line` table | Above and in research.md. Re-verify before each phase starts, because references rot |
| VIII. Comments | The scoped-caller table carries the reason for each refused class, in the style of `control-plane-routes.ts` |

## Scoped-caller route table (FR-010)

These rules apply to a capability-verified session whose employee has non-empty `projects`.
**P** is the session's bound project. The table lives in
`packages/jinn/src/gateway/project-scope/rules.ts`. A route that is not listed is refused with
403 `"not available to a project-scoped session"`. Out-of-project ids return the same 404 as
unknown ids.

| Route(s) | Scoped behaviour |
| --- | --- |
| `GET /api/work-items`, `/api/work-items/trees`, `/api/search/work-items` | `project` forced to P. A caller-supplied `project` other than P gives an empty page |
| `POST /api/work-items` | Created in P. A `project` other than P → 403. `parentId` outside P → 404 |
| `GET/PATCH /api/work-items/:id`, `/status`, `/tree`, `/sessions`, `/kept`, `/comments` (+ sub-routes), `/attachments` (+ sub-routes) | Todo must be in P, else 404. Existing standing rules then apply unchanged |
| `POST /api/work-items/:id/assign`, `/dispatch`, `POST /api/delegations` | Todo in P, and target employee scoped to P (FR-015) |
| `PUT /api/work-items/:id/dispatch-config` | Todo in P, and every skill on the project allow-list (FR-026) |
| `/api/work-items/:id/relations` | Both ends in P |
| `PUT /api/work-items/:id/labels`, `GET /api/labels` | Apply existing labels only. Creating a label is refused |
| `PUT /api/work-items/:id/project`, `PUT /api/work-items/:id/sprint`, `/archive` | Refused |
| `GET /api/sessions`, `/api/search/sessions`, `/api/search/messages`, message context | Filtered to `project_id = P` |
| `GET /api/sessions/:id` (+ `/messages`, `/children`, `/transcript`, `/context`) | Session bound to P, else 404 |
| `POST /api/sessions` (spawn) | Target employee scoped to P. Child bound to P. Parent, if named, bound to P |
| `POST /api/sessions/:id/message`, `/stop`, compact | Target bound to P (stop: own descendants only, as today) |
| `POST /api/sessions/:self/attachments` | Own session only. `publish_attachment` path policy (FR-016) |
| `GET /api/org`, `GET /api/org/employees/:name` | Members of P only. Departments omitted. Others → 404 |
| `GET /api/knowledge/search`, `/api/knowledge/read`, `GET /api/notes*` | Rooted at `knowledge/projects/<P>/` plus P's shared Notes |
| `POST/PUT /api/notes` | Only under `knowledge/projects/<P>/` |
| Heartbeat routes | Own session only (unchanged semantics) |
| Engine-internal routes (`isPublicIdentifiedCallerRoute`, hook endpoint, status line) | Unchanged |
| **Everything else** | Refused. This covers config, cron, cost, connectors, files, skills, sprints, departments, labels admin, org writes, instances, engines, limits, board walk, onboarding, auth, logs and backup |

Phase 2's first task enumerates every route registered on `main` and classifies it. The
enumeration test (SC-001) keeps the table complete from then on.

### Assignee scope from every caller (FR-015)

The same predicate applies on assign, delegate, dispatch, board walk, Shaper routing and
create-with-assignee. The predicate is `mayHoldTodo(employee, todoProject)`:

- an unscoped employee may hold any Todo;
- a scoped employee may hold only Todos in its projects;
- a company Todo cannot go to a scoped employee.

It lives in `project-scope/assignee.ts` and is called at each path. The board walk projection
must skip an ineligible pairing silently, and must not hand it to the dispatcher only to be
refused.

### Scoped MCP profile

`mcp/project-profile.ts` removes the tools whose routes are all refused:

- `list_cron_jobs`
- `get_cron_run_history`
- `cost_report`
- `send_connector_message`
- `list_files`
- `read_file`
- `list_departments`

The resolver selects the profile for scoped sessions only. Unscoped manifests are byte-identical
(SC-002).

## Phases

### Phase 0: containment spike (senior-developer, only under Q1 = B)

This phase writes no product code. It uses a throwaway sandbox gateway and a hand-built stage
dir. It answers research.md "Containment" items 1–6 and records each answer, with the commands
and their output, in research.md under "Phase 0 findings".

Exit criteria:
- the US3 escape script passes by hand;
- the settings blocks and environment allow-list that make it pass are written down.

If it fails, stop and report to the operator. Phase 4 is then dropped, and Q1 falls back to A.

### Phase S: existing security gaps (junior-developer; reviewed by senior QA)

- **Red test first:** `read_knowledge` of `secrets/mcp-session-capability.key` returns the key
  on `main`.
- Apply `shared/protected-home-entries.ts` to `readKnowledgeFile` and to `publish_attachment`.
  This flips two tests that currently *assert* the gap:
  - `gateway/__tests__/knowledge-route.test.ts:155`
  - `mcp/__tests__/knowledge-tools.test.ts:152`

  Their new assertions are the fix. `config.yaml` stays readable unless the operator says
  otherwise (it holds the bot token too, so ask in the PR).

### Phase 1: projects as a grouping (junior-developer)

- **Backend:**
  - `work-items/projects-schema.ts`, `projects.ts` (CRUD and archive),
    `project-membership.ts` (root-only, `project_changed` event);
  - list filter `project=<id>|none`;
  - payload `project`;
  - `gateway/projects-api.ts` (`GET/POST /api/projects`, `GET/PATCH /api/projects/:id`,
    `POST /api/projects/:id/archive|unarchive`, `PUT /api/work-items/:id/project`);
  - project config child tables, with the env API returning names and `resolved` only;
  - `company:changed {entity:"project"}` added to the gateway-events payloads.
- **Web:**
  - `lib/project-api.ts` and `use-projects`;
  - a `project` filter in the four `lib/todos.ts` places (`TodoFilters`, both URL mappers,
    `FILTER_PARAM_KEYS`) and the `use-board` query key;
  - a filter chip in `filter-bar.tsx`;
  - a badge in card Row 1 and in list rows, coloured per project with the `deptHue` helper;
  - a `PropertyChip` in `new-todo-dialog.tsx`;
  - a rail row in `props-rail.tsx`, modelled on `sprint-rail-row.tsx`;
  - the Projects page route (`app-routes.ts`, `main.tsx`, talk-surface coverage), built from
    `PageScaffold` and `LargeTitleHeader`, with list, create, rename, describe, archive,
    working directories, skills, shared Notes and env names;
  - a project switcher registered as a `statusbar.right` contribution, plus the chat
    sidebar's header row because chat has no status bar. It sets the board's project filter
    and narrows the sidebar session list.
- **Visual tests:** `scripts/verify-projects.sh`, `playwright.projects.config.ts` and a
  seeding script, using the chat-grid-drop sandbox pattern. Each element is captured in
  light and dark. Evidence goes to the PR with `gh pr comment --attach`.

### Phase 2: scoped employees (junior-developer; enforcement reviewed by senior QA)

- Employee `projects`, read in `org.ts`, validated (unknown id → scoped to nothing,
  claude-only, no system employees), and added to `WRITABLE_FIELDS`.
- `sessions.project_id` and the binding in `spawnSession`. Unscoped sessions get a badge-only
  binding from their linked Todo.
- `gateway/project-scope/{caller.ts,rules.ts,assignee.ts}` and the gate call at `gateway/api.ts:1181`.
  Per-route filtering goes in the handlers through one helper, `scopeFor(caller)`, which
  returns `null` for unscoped callers. Every scoped branch is behind it, so unscoped paths do
  not change.
- `mcp/project-profile.ts` and the resolver selection.
- `buildContext`: a roster limited to members, and a project section (name, description,
  working directories).
- `refuseTurn`: refuse when the session's binding is no longer in the employee's scope.
- **Web:**
  - a project-scope control in `employee-editor.tsx`, using `api.updateEmployee` and the
    `EmployeeUpdate` type;
  - a project badge in `chat-sidebar.tsx` `SessionRow`, `mobile-session-row.tsx` and
    `session-tree.tsx` `TreeRow`.

  Both get light and dark screenshots.
- **Tests:**
  - the route-enumeration test;
  - allow and refuse tests for every table row;
  - assignee tests for every assignment path;
  - the SC-002 equality tests (manifest, `buildContext` and argv for an unscoped roster).

### Phase 3: scoped context (junior-developer)

- Stage dir generation (data-model.md), regenerated on skill or project change.
  `engine-run.ts` uses it as cwd for scoped sessions.
- **Risk:** Claude transcripts are keyed by cwd slug (`sessions/fork.ts:164`,
  `engines/claude-interactive.ts:271`). Resume, fork and auto-compaction must resolve the
  stage-dir slug. Trust entries in `~/.claude.json` are seeded for the stage dir
  (`shared/claude-settings.ts:124`).
- Skill allow-list in the links, the prompt and the `dispatchConfig.skills` check.
- `SEARCH_ROOTS` becomes a parameter. Scoped callers get the project folder plus shared paths.
- `INSTRUCTIONS.md` becomes the stage `CLAUDE.md`, with company `CLAUDE.md` appended only for
  `project+company`.

### Phase 4: containment (senior-developer, Q1 = B, from the Phase 0 findings)

- Allow-list environment builder beside `buildEngineChildEnv`, with project secret
  references resolved from `secrets/` at spawn. Values are never logged.
- Sandbox and `permissions.deny` blocks in the scoped session settings.
- The capability is passed on the MCP server's environment. `server-bootstrap.ts` does not
  derive it when one is given.
- A 401 for unauthenticated requests, by whichever mechanism Phase 0 proved (loopback blocked
  by the sandbox, or gateway auth on with the operator's approval).
- The escape script goes in as `scripts/verify-project-containment.sh`, and its output is
  attached to the PR.

## Delegation split

The org's spec-kit split puts the senior on the spec and plan and the junior on implementation.
This feature is mostly security and auth, which is the senior trigger, so the split here is:

- **junior-developer:** Phases S, 1, 2 and 3. Each is its own Todo with this spec as acceptance
  criteria. They are well specified, but S and 2 are security-sensitive, so each goes to
  **senior QA**, never junior QA.
- **senior-developer:** Phases 0 and 4. Both settle ambiguity about engine behaviour and
  change spawn infrastructure (blast radius: the boundary itself).

## Complexity Tracking

| Item | Why it is needed | Simpler alternative rejected because |
| --- | --- | --- |
| Six tables, not one with JSON config | Each list is queried or validated on its own (skills against `skills/`, env names against `secrets/`), and the sprint verifier style wants exact-shape rows | A JSON column cannot be checked by the boot data check, and invites values where names belong (FR-030) |
| A second route table beside the connector's | The scoped principal's allow-list differs from the connector's in almost every row | Sharing one table with a principal column makes both harder to audit |
| A stage dir per project | It is the only lever that limits skills and instructions for a Claude engine without filtering the shared home | A prompt-only restriction ("don't use skill X") is not a restriction |
