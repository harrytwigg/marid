# Implementation Plan: Projects and Project-Scoped Employees

**Branch**: `feat/project-scoping-spec` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md with the operator's decisions of 2026-10-05:

- **Enforcement:** MCP and the gateway only, with no sandbox (Q1 = A).
- **Delegation:** members only (Q2 = a).
- **Storage:** YAML project definitions.
- **MCP:** no new parameter.
- **Instructions:** the project's own instructions only.
- **Existing employees:** unchanged (Q6 = b).
- **Holding Todos:** the `dedicated` flag.
- **Chrome:** unchanged.
- **Replies:** live replies.
- **New:** org tree badges and YAML-first configuration.
- **Not built:** employees on their own Claude account use the existing per-employee profile
  setting (spec.md, "Employees on another Claude account").

## Existing infrastructure (constitution VII)

research.md has the full audit. This table lists the rows the plan builds on, verified
against `origin/main` at `60e675d6`.

| `path:line` | Used for |
| --- | --- |
| `packages/jinn/src/gateway/org-registry.ts:42` | `refreshOrg` / last-good roster: the shape copied for `project-registry.ts` |
| `packages/jinn/src/gateway/watcher.ts:130` | The `org/` watcher, copied for `projects/` |
| `packages/jinn/src/gateway/org.ts:170` | `WRITABLE_FIELDS` gains `projects` |
| `packages/jinn/src/backup/archive.ts:9` | `ARCHIVE_INCLUDES` gains `projects` |
| `packages/jinn/src/work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`: `work_item_projects` is added here |
| `packages/jinn/src/work-items/sprints-schema.ts:60` | The root-membership filter, copied for `project` |
| `packages/jinn/src/gateway/sprints-api.ts:228` | The route-table module shape for `projects-api.ts` |
| `packages/jinn/src/gateway/api.ts:1181` | The identified-caller gate. The scoped gate is one line beside it |
| `packages/jinn/src/gateway/remote-mcp/rules.ts:25` | The allow-list table shape for `project-scope/rules.ts` |
| `packages/jinn/src/gateway/remote-mcp/profile.ts:98` | The tool-profile filter shape |
| `packages/jinn/src/gateway/api.ts:2148` / `:1744` | The `ids=`, `pinned` and `q` branches, served by the scoped read module |
| `packages/jinn/src/work-items/store.ts:356` | `createWorkItem` insert: an `assignee` writer |
| `packages/jinn/src/work-items/assignment.ts:98` | `assignWorkItem`'s own `UPDATE` of `assignee`, which does not go through `releaseOnOwnerChange` |
| `packages/jinn/src/gateway/api.ts:1207` | Note routes gated on `notesEnabled`. Scoped callers are served regardless (FR-028) |
| `packages/jinn/src/gateway/server.ts:565` | The only trust seed today: boot-time, for `$JINN_HOME`. Phase 3 adds one per stage dir |
| `packages/jinn/src/work-items/store.ts:797` / `:850` | The two dynamic update paths, followed by `releaseOnOwnerChange` |
| `packages/jinn/src/gateway/api.ts:3450` | The delegation route creates a Todo already assigned |
| `packages/jinn/src/plugins/host/todos.ts:31` | A plugin create with `draft.assignee` |
| `packages/jinn/src/cron/runner.ts:101` | A cron-created Todo |
| `packages/jinn/src/gateway/todo-assignee.ts:21` | `@operator` is a valid assignee |
| `packages/jinn/src/gateway/spawn-session.ts:163` / `:188` | Session binding (FR-008). `parentSessionId` is the FR-013 requester |
| `packages/jinn/src/gateway/server.ts:1035` | Upgrade handling: the scoped refusal goes in the upgrade guard |
| `packages/jinn/src/sessions/turn/engine-run.ts:46` | cwd becomes the stage dir for scoped sessions |
| `packages/jinn/src/gateway/watcher.ts:38` | `syncSkillSymlinks`: the regeneration trigger for stage dirs |
| `packages/jinn/src/notes/store.ts:613` | `SEARCH_ROOTS` becomes a parameter |
| `packages/jinn/src/sessions/turn/preflight.ts:52` | `refuseTurn`: refuses on a lost binding or a wrong engine |

## Summary

Three PRs, each off `main`, built in order. Each phase starts only after the previous one
merges.

1. **Phase 1: projects as a grouping.** This covers:
   - the YAML project registry, with its watcher, ids-seen record and backup;
   - `work_item_projects`, the `project` filter, payloads and events;
   - projects REST: reads, and atomic operator writes to the YAML;
   - FR-033 validation;
   - web: the board filter and badge, the create and detail field, the Projects page and the
     switcher.

   Nobody is restricted yet.
2. **Phase 2: scoped employees.** This covers:
   - explicit `projects` scope and the session binding;
   - the scoped-caller gate and its read module;
   - `mayHoldTodo` with `dedicated`, where an unknown id fails closed;
   - FR-018 path limits;
   - the filtered MCP profile, which carries the note tools, and the scoped roster;
   - `JINN_PROJECT_ID`;
   - web: org tree badges and filter, the employee scope control, session badges and the
     new-chat project picker.

   Until Phase 3, scoped employees still load the company `CLAUDE.md` and skills. That is
   acceptable under Q1 = A on the operator's account (spec.md, "Scope of the boundary").
3. **Phase 3: scoped context.** This covers:
   - the stage dir as cwd, with its own trust seed;
   - skill copies and the generated `CLAUDE.md`, including the scope paragraph;
   - Notes and state roots;
   - claude-only validation.

Phase S, Phase 0 and the old containment phase are withdrawn (Q1 = A, Q6 = b).

## Technical Context

**Language/Version**: TypeScript, Node ≥ 22. Web: React 19, Vite and TanStack Query 5.

**Primary Dependencies**: none new. The YAML is parsed with the parser `org.ts` already uses.

**Storage**:
- YAML under `projects/`;
- one additive registry table, plus one added `sessions` column;
- employee YAML fields;
- generated stage dirs outside the home.

**Testing**:
- vitest. Enforcement tests drive the real `handleApiRequest` as a capability-bound scoped
  session against a seeded temp home that has `projects/` and `org/` YAML.
- Web: Testing Library. Playwright runs against a sandbox gateway for the light and dark
  evidence.

**Constraints**:
- **Size ratchet.** It is already red on `main` (`node scripts/ratchet.mjs --check`: 102
  violations). No file that is at or over budget may grow. The at-budget files:
  - `gateway/api.ts`: 4798 lines of a 4803 budget;
  - `mcp/server.ts`: 326 of 326;
  - `sessions/context.ts`: 1002 of 906, already over;
  - `packages/web/src/lib/api.ts`: 876 of 876.
- **Edits to `api.ts`.** It gets only the gate line, the `projects-api.ts` mount and a
  one-line create hook (`gateway/work-item-create-project.ts`, as with
  `work-item-create-sprint.ts`). The list filter is parsed in `gateway/work-item-query.ts`, and
  `mayHoldTodo` lives in the store. The PR pays for its `api.ts` lines by moving
  `GET /api/sessions` (`gateway/api.ts:1743`) into `gateway/sessions-list-api.ts`.
- **Scoped enforcement** lives at the gate and in `gateway/project-scope/*`. No existing
  handler is edited for scoping.
- **Manifest.** The core manifest is at 4155 of 4156 on pi. Nothing adds a parameter.
  - The core and unscoped manifests are unchanged, so SC-004 holds.
  - The scoped profile is smaller than the core manifest. It removes 9 tools, then adds back
    the 4 note tools that `notesEnabled: false` gates out of the default manifest
    (`mcp/server.ts:119`): a net of −9 / +4 tools.
- **Privacy guard.** Fixtures use invented names and paths.

## Constitution Check

| Principle | Status |
| --- | --- |
| I | Pass |
| II | Rung 4, justified in spec.md "Why This Matters" |
| III | Every premise has a `path:line` in research.md. Phase 2 opens with a red test: on `main`, a session of an employee with `projects` set can list company Todos |
| IV | Rung 1 throughout. No new core tool, and the manifest does not grow (attested hash) |
| V | Every table, field and key has a v1 consumer. Secrets, sandboxing, the per-employee account, a client layer and project cron are all deferred |
| VI | Enforcement tests assert allow and refuse outcomes. The route-enumeration test fails on an unclassified route. No snapshots: SC-002 is one-off PR evidence |
| VII | The table above. Re-verify it before each phase |
| VIII | Each refused class in the scoped table carries its reason |

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
| `POST /api/sessions/:id/message` | Target bound to P, **or** the caller's own `parent_session_id` (FR-013, live send-only, Q10-a) | gate |
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

### Phase 1: projects as a grouping (junior-developer, then junior QA)

This phase carries no auth or secrets risk.

**Backend**

- `gateway/project-registry.ts`: scan, validation (data-model.md), last-good set, watcher, and
  `company:changed {entity:"project"}`.
- `projects` added to `ARCHIVE_INCLUDES`.
- `work-items/projects-schema.ts` (`work_item_projects` plus the root-only boot check) and
  `work-items/project-membership.ts` (root-only move, `project_changed` event, batch read).
- The list filter `project=<id>|none`, the payload `project`, create-time `project`, and
  `parentId` inheritance.
- `gateway/projects-api.ts`:
  - `GET /api/projects` and `GET /api/projects/:id`;
  - `POST /api/projects`, which writes a new YAML with a generated id;
  - `PATCH /api/projects/:id`, which rewrites that YAML;
  - `PUT /api/work-items/:id/project`.

  Writes are operator-only, added to `control-plane-routes.ts`. Until Phase 2, writes to
  `dedicated` are refused, because nothing enforces it yet.

**Web**

- `lib/project-api.ts`.
- The `project` filter in the four `lib/todos.ts` places and the `use-board` key.
- The filter chip, the card Row 1 badge and the list badge. An unknown project shows as
  "unknown project".
- The create `PropertyChip` and the detail rail row, modelled on `sprint-rail-row.tsx`.
- The Projects page, with an "Edit YAML" hint showing the file path.
- The switcher, as a status bar contribution and in the chat sidebar header.

**Visual**: `scripts/verify-projects.sh`, a Playwright config and a seed script, captured in
light and dark and attached to the PR.

### Phase 2: scoped employees (senior-developer; junior sub-Todos for the test matrix and the web; senior QA)

Senior, because it is the enforcement itself.

**Gateway**

- Employee `projects` handling: FR-007 semantics and validation, plus `WRITABLE_FIELDS`.
- `sessions.project_id` and the binding in `spawnSession`. Connector sessions for scoped
  employees are refused.
- `gateway/project-scope/{caller,rules,read-routes,paths,assignee}.ts`, the gate line, and the
  upgrade-guard refusal.
- `mayHoldTodo` and the guard at every SQL writer of `assignee`: `work-items/store.ts:356`, the two
  dynamic update paths, and `work-items/assignment.ts:98`. Scope comes from a resolver injected at boot,
  with the FR-015 fallbacks, including "an unknown id counts as dedicated". It is checked at the entry of every path that starts work.
- The stranding refusals. `dedicated` writes are enabled here.
- FR-018 path checks. `list_files` and `read_file` are refused.
- `mcp/project-profile.ts`. It removes the refused tools and always includes the note tools, rooted at P's folder, even when `notesEnabled` is off.
- `JINN_PROJECT_ID` in scoped sessions' engine environment.
- `sessions/context/project.ts`: a members-only roster and a project section.
- The `refuseTurn` lost-binding check.
- An `escalated` event when a Todo leaves P.
- Hidden counts.
- The archived and unknown project spawn rules.
- Cron validation.

**Web (junior sub-Todo)**

- Org tree project badges and a project filter (FR-041).
- The employee-editor scope control: `all` or a list, never empty.
- The Projects page `dedicated` toggle.
- Session badges in `SessionRow`, `mobile-session-row` and `TreeRow`.
- The new-chat project picker.
- Light and dark screenshots of each.

**Tests (junior sub-Todo, from the table)**

- Route enumeration.
- An allow and a refuse case for every row.
- 404 bodies identical to an unknown id.
- `mayHoldTodo` at every writer and entry, including `dedicated`, `@operator` and the
  fallbacks.
- FR-009 and FR-013.
- An emptied scope fails closed.
- The SC-002 one-off comparison, recorded in the PR.

### Phase 3: scoped context (junior-developer, then senior QA)

The stage dir lives at `<parent of home>/.jinn-projects/<id>/`.

- **Contents.** It holds copies of the allowed skills and a generated `CLAUDE.md`. The
  `CLAUDE.md` is built from `INSTRUCTIONS.md`, plus the company `CLAUDE.md` if
  `project+company` is set, plus the FR-029 scope paragraph.
- **Regeneration.** It is rebuilt on skill changes, on project scan changes and on
  instruction changes.
- **Use.** `engine-run.ts` uses it as the cwd for scoped sessions. A new trust seed for the
  stage dir is written when the dir is generated. Today the only seed is the boot-time one
  at `gateway/server.ts:565`.
- **Transcripts.** Resume, fork and auto-compaction resolve the stage-dir transcript slug.
  Each gets a regression test.
- **Skill allow-list.** It applies to the copies, the prompt and `dispatchConfig.skills`.
- **Notes.** `SEARCH_ROOTS` becomes a parameter. Scoped callers search the project folder,
  which includes `state.md`, plus `sharedNotes`. Note writes go only into the project folder.
- **Validation.** Scoped employees are claude-only.
- **Docs.** The template docs explain projects, project state through the note tools, and the
  fact that this is a guardrail, not a sandbox. They do not mention `mem`, which is
  instance-local.

## Delegation split

| Phase | Producer | Reviewer | Trigger |
| --- | --- | --- | --- |
| 1 | junior | junior QA | Fully specified, with no auth or secrets |
| 2 | senior, with junior sub-Todos for the tests and the web | senior QA | Auth enforcement |
| 3 | junior | senior QA | Specified, but it decides what a scoped session can load |

## Complexity Tracking

| Item | Why | Simpler alternative rejected because |
| --- | --- | --- |
| A YAML scan that refuses only on identity problems, with unknown ids failing closed | A missing skill or a moved working directory must not unscope members or open a dedicated project | Refusing the whole file on any error, which QA showed fails open on `dedicated` |
| Project definitions in YAML, membership in the DB | The operator wants YAML configuration (Q3), and it is the same split as employees (YAML) versus assignees (registry names) | All-DB loses hand editing. All-YAML would put Todo membership in files that every Todo write would have to rewrite |
| A second route table beside the connector's | The scoped principal differs from the connector in almost every row | One table with a principal column is harder to audit |
| A scoped read module instead of filters inside handlers | Handlers are over budget and have unfiltered branches (`ids=`, `pinned`, `q`) | Threading `project` through every branch is where a missed branch leaks |
| A stage dir outside the home, with copied skills | Claude loads the ancestor `CLAUDE.md`, and the shared skills dir sits under the home | A prompt-only "do not use skill X" is not a restriction |
