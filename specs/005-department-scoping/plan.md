# Implementation Plan: Department-Scoped Employees and Per-Employee Claude Profiles

**Branch**: `feat/project-scoping-spec` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md with the operator's decisions:

- **Enforcement:** MCP and the gateway only, with no sandbox (Q1 = A).
- **Delegation:** members only (Q2 = a).
- **Unit of scope:** the department, defined in `org/<slug>/department.yaml` (D1).
- **MCP:** no new parameter.
- **Instructions:** the department's own instructions only.
- **Existing employees:** unchanged (Q6 = b).
- **Holding Todos:** `scope: dedicated`.
- **Replies:** live replies.
- **Accounts:** a per-employee local Claude profile, `claudeConfigDir` (D2).
- **Spec's own choice:** scoped employees run locally (FR-026).

## Existing infrastructure (constitution VII)

research.md has the full audit. This table lists the rows the plan builds on, verified
against `origin/main` at `3c032251`.

| `path:line` | Used for |
| --- | --- |
| `packages/jinn/src/gateway/org-registry.ts:42` | `refreshOrg` / last-good roster: the shape for `department-registry.ts` |
| `packages/jinn/src/gateway/org.ts:31` | The org walker skips `department.yaml`. It keeps doing so; the department registry reads it |
| `packages/jinn/src/gateway/org.ts:81` | An employee's department: the field, else the directory |
| `packages/jinn/src/gateway/org.ts:112` | Per-employee validation that skips a bad employee. The scope and profile checks go beside it |
| `packages/jinn/src/gateway/watcher.ts:130` | The `org/` watcher, which already covers `department.yaml` |
| `packages/jinn/src/work-items/assignment.ts:72` | `departmentAfterAssignment`: keeps a non-open department (FR-003) |
| `packages/jinn/src/gateway/api.ts:2650` | The assign route passes `employee?.department ?? null`, so `@operator` nulls the department |
| `packages/jinn/src/work-items/store.ts:324` | Create: the department comes from the input, then the parent, then the policy default |
| `packages/jinn/src/work-items/departments.ts:80` | `listDepartmentsWithCounts`: the `GET /api/departments` rows, which gain the definition |
| `packages/jinn/src/work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`: `department_scopes` is added here |
| `packages/jinn/src/gateway/api.ts:1181` | The identified-caller gate. The scoped gate is one line beside it |
| `packages/jinn/src/gateway/remote-mcp/rules.ts:25` | The allow-list table shape for `department-scope/rules.ts` |
| `packages/jinn/src/gateway/remote-mcp/profile.ts:98` | The tool-profile filter shape |
| `packages/jinn/src/work-items/store.ts:356` | `createWorkItem` insert: an `assignee` writer |
| `packages/jinn/src/work-items/store.ts:797` / `:850` | The two dynamic update paths, followed by `releaseOnOwnerChange` |
| `packages/jinn/src/work-items/assignment.ts:98` | `assignWorkItem`'s own `UPDATE`, which does not go through `releaseOnOwnerChange` |
| `packages/jinn/src/gateway/api.ts:3450` / `:3501` | Delegation: create-already-assigned, and assignment onto an existing Todo |
| `packages/jinn/src/plugins/host/todos.ts:31` | A plugin create with `draft.assignee` |
| `packages/jinn/src/cron/runner.ts:101` | A cron-created Todo |
| `packages/jinn/src/gateway/todo-assignee.ts:21` | `@operator` is a valid assignee |
| `packages/jinn/src/gateway/spawn-session.ts:163` / `:188` | Session binding (FR-008). `parentSessionId` is the FR-013 requester |
| `packages/jinn/src/gateway/server.ts:1035` | Upgrade handling: the scoped refusal goes in the upgrade guard |
| `packages/jinn/src/gateway/api.ts:1207` | Note routes gated on `notesEnabled`. Scoped callers are served regardless (FR-028) |
| `packages/jinn/src/notes/store.ts:613` | `SEARCH_ROOTS` becomes a parameter |
| `packages/jinn/src/sessions/turn/engine-run.ts:46` | cwd becomes the stage dir for scoped sessions |
| `packages/jinn/src/sessions/turn/preflight.ts:52` | `refuseTurn`: lost binding, wrong engine, profile not signed in |
| `packages/jinn/src/gateway/watcher.ts:38` | `syncSkillSymlinks`: the regeneration trigger for stage dirs |
| `packages/jinn/src/gateway/server.ts:565` | The only local trust seed today: boot-time, default profile, `$JINN_HOME` |
| `packages/jinn/src/shared/home.ts:34` / `:42` | `resolveClaudeConfigDir` / `claudeJsonPath`: gain a profile argument |
| `packages/jinn/src/shared/child-env.ts:41` | `buildEngineChildEnv`: the profile's `CLAUDE_CONFIG_DIR` goes in here |
| `packages/jinn/src/shared/remote-target.ts:114` / `:230` | The remote profile's validation and precedence: the pattern for the local field |
| `packages/jinn/src/engines/remote-stage.ts:658` | `verifyClaudeProfile`: the pattern for the local signed-in check |
| `packages/jinn/src/shared/claude-auth-outage.ts:18` | `LOCAL_CLAUDE_AUTH_SCOPE`: gains a per-profile form |
| `packages/jinn/src/shared/engine-health.ts:54` | `engineHealthForTarget`: gains a profile qualifier |

## Summary

Four PRs, each off `main`. Phases 1 → 2 → 3 are built in order. Phase 4 is independent and may
run alongside them once this spec merges.

1. **Phase 1: departments carry a scope.** This covers:
   - `department.yaml` loading, validation and the last-good `department_scopes` table;
   - assignment and sub-task rules for non-open departments (FR-003, FR-004);
   - the employee field-and-directory check (FR-007);
   - `GET /api/departments` gaining the definition, `GET /api/departments/:slug`, and the
     operator-only `PATCH /api/departments/:slug`;
   - FR-033 validation;
   - web: scope badges on the board switcher and the org tree, and the department panel.

   Nobody is restricted yet. Writes that set a non-open scope through the API are refused
   until Phase 2, because nothing enforces them yet. YAML can set them, and Phase 1's
   assignment rules then apply.
2. **Phase 2: scoped employees.** This covers:
   - the session binding;
   - the scoped-caller gate and its read module;
   - `mayHoldTodo` with `dedicated` and the last-good fallback;
   - FR-018 path limits;
   - the filtered MCP profile, which carries the note tools, and the scoped roster;
   - `JINN_DEPARTMENT`;
   - web: session badges, and scope editing in the department panel.

   Until Phase 3, scoped employees still load the company `CLAUDE.md` and skills, on the
   operator's own account (FR-059 keeps named profiles off scoped employees until then).
3. **Phase 3: scoped context.** This covers:
   - the stage dir as cwd, with its own trust seed;
   - skill copies and the generated `CLAUDE.md`, including the scope paragraph;
   - Notes and state roots;
   - claude-only, local-only validation.
4. **Phase 4: per-employee Claude profiles.** This covers:
   - `claudeConfigDir` validation;
   - the environment on every launch path;
   - the per-profile trust seed;
   - the transcript readers;
   - the signed-in check;
   - per-profile outage, health, rate-limit memory and limits;
   - no cross-account fallback;
   - the remote profile fix (FR-058);
   - the FR-059 refusal for scoped employees, lifted once Phase 3 has merged;
   - web: the profile badge and the read-only profile row.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 22. Web: React 19, Vite and TanStack Query 5.

**Primary Dependencies**: none new. The YAML is parsed with the parser `org.ts` already uses.

**Storage**:
- `department.yaml` under each `org/<slug>/`;
- one additive registry table, plus one added `sessions` column;
- one employee YAML field;
- generated stage dirs outside the home.

**Testing**:
- vitest. Enforcement tests drive the real `handleApiRequest` as a capability-bound scoped
  session against a seeded temp home that has `org/` YAML, including `department.yaml` files.
- Profile tests assert the spawned environment and transcript paths with a fake profile
  directory. The Keychain check is behind an injectable probe, so tests never touch the real
  Keychain.
- Web: Testing Library. Playwright runs against a sandbox gateway for the light and dark
  evidence.

**Constraints**:
- **Size ratchet.** It is already red on `main` (`node scripts/ratchet.mjs --check`). No file
  that is at or over budget may grow. Measured on `3c032251`:
  - `gateway/api.ts`: 4798 lines of a 4803 budget;
  - `mcp/server.ts`: 326 of 326;
  - `sessions/context.ts`: 1002, already over;
  - `engines/claude-interactive.ts`: 3478. Phase 4 threads the profile through it, so it must
    move code out to pay for what it adds.
- **Edits to `api.ts`.** It gets only the gate line, a `departments-api.ts` mount and the
  one-line FR-003 fix at the assign route. The PR that adds them pays for them by moving
  `GET /api/sessions` (`gateway/api.ts:1743`) into `gateway/sessions-list-api.ts`.
- **Scoped enforcement** lives at the gate and in `gateway/department-scope/*`. No existing
  handler is edited for scoping.
- **Profile threading** goes through one value, `ClaudeProfile` (`{ dir, key }` or null),
  resolved once per session from the employee in `shared/claude-profile.ts`. No launch site
  reads `process.env.CLAUDE_CONFIG_DIR` directly.
- **Manifest.** Nothing adds a parameter. The core and unscoped manifests are unchanged, so
  SC-004 holds. The scoped profile is smaller than the core manifest.
- **Privacy guard.** Fixtures use invented names and paths.

## Constitution Check

| Principle | Status |
| --- | --- |
| I | Pass |
| II | Rung 4, justified in spec.md "Why This Matters" |
| III | Every premise has a `path:line` in research.md. Phase 1 opens with a red test: on `main`, assigning a Todo in department D to an Engineering employee moves it to Engineering. Phase 2 opens with one: a session of an employee in a scoped department can list company Todos. Phase 4 opens with one: an employee with `claudeConfigDir` set spawns without `CLAUDE_CONFIG_DIR` |
| IV | Rung 1 throughout. No new core tool, and the manifest does not grow (attested hash) |
| V | Every table, field and key has a v1 consumer. Secrets, sandboxing, scoped remote employees and department cron are deferred |
| VI | Enforcement tests assert allow and refuse outcomes. The route-enumeration test fails on an unclassified route. No snapshots: SC-002 is one-off PR evidence |
| VII | The table above. Re-verify it before each phase |
| VIII | Each refused class in the scoped table carries its reason |

## Scoped-caller route table (FR-010)

**Who it applies to**: a capability-verified session whose employee is scoped. **D** is
`sessions.scope_department`.

**Where it lives**: `packages/jinn/src/gateway/department-scope/rules.ts`.

**Default deny**: any unlisted route returns 403, "not available to a department-scoped
session".

**Hiding other departments**: an out-of-department id returns the same 404 as an unknown id.

| Route(s) | Scoped behaviour | Where |
| --- | --- | --- |
| `GET /api/work-items` (both the `ids=` and query forms), `/api/work-items/trees`, `/api/search/work-items` | Only D's Todos (by root). `ids=` drops non-D ids silently. A `department` other than D returns an empty page | read-routes |
| `POST /api/work-items` | Lands in D, whatever it names. A `parentId` outside D returns 404 | gate check, then handler |
| `GET/PATCH /api/work-items/:id`, `/status`, `/tree`, `/kept`, `/comments` (+ sub-routes), `/attachments` (multipart, + sub-routes) | Todo must be in D, otherwise 404. The existing standing rules then apply | gate |
| `POST /api/work-items/:id/attachments` with JSON `{path}` | As above, plus the FR-018 path check | gate |
| `GET /api/work-items/:id/sessions` | Todo in D. Lists only sessions bound to D, plus `hiddenCount` | read-routes |
| `POST /api/work-items/:id/assign`, `/dispatch`, `POST /api/delegations` | Todo in D. The target must be a member of D (FR-016). `mayHoldTodo` also runs inside `assignWorkItem` | gate + core |
| `PATCH /api/work-items/:id` setting `assignee` | `mayHoldTodo` | store |
| `PUT /api/work-items/:id/dispatch-config` | Todo in D, and every skill must be on D's allow-list | gate |
| `/api/work-items/:id/relations` | Both ends in D. Reads report other relations as a hidden count | gate + read-routes |
| `POST /api/work-items/:id/capture-landing` (`land_on_work_item`) | Todo in D | gate |
| `PUT /api/work-items/:id/labels`, `GET /api/labels` | Existing labels only | gate |
| `/sprint`, `/archive`, label create, any department change | Refused | — |
| `GET /api/sessions` (every branch), `/api/search/sessions`, `/api/search/messages`, message context | Only sessions bound to D | read-routes |
| `GET /api/sessions/:id` (+ `/messages`, `/children`, `/transcript`, `/context`) | Session must be bound to D, otherwise 404 | gate |
| `POST /api/sessions` (spawn) | Target a member of D. The child is bound to D. A named parent must be bound to D | gate + `spawnSession` |
| `POST /api/sessions/:id/message` | Target bound to D, **or** the caller's own `parent_session_id` (FR-013, live send-only, Q10-a) | gate |
| `POST /api/sessions/:id/stop`, `POST /api/compactions` | Target bound to D. Stop is limited to own descendants, as today. Compaction is limited to own session | gate |
| `POST /api/sessions/:self/attachments` (`publish_attachment`) | Own session only. The FR-018 path check runs in the MCP tool | gate + tool |
| `GET /api/org`, `GET /api/org/employees/:name` | D's members only. Anyone else returns 404 | read-routes |
| `GET /api/departments` | Only D | read-routes |
| `GET /api/knowledge/search`, `/api/knowledge/read`, `GET /api/notes*`, `POST/PUT /api/notes` | Rooted per FR-028. Writes go only under the department folder | read-routes |
| Heartbeat routes | Own session only (as today) | gate |
| Engine-internal routes (`isPublicIdentifiedCallerRoute`, the hook endpoint, the status line) | Unchanged | — |
| WebSocket upgrades (`/ws`, `/ws/pty/:sessionId`, plugin events) | Refused for scoped callers. They are outside `handleApiRequest`, so the check sits in the upgrade guards (`gateway/upgrade-guards.ts`) | upgrade guard |
| **Everything else** | Refused. This covers config, cron, cost, connectors, files, `/api/search/global`, skills, sprints, `GET /api/departments/:slug`, department writes, label admin, org writes, instances, engines, limits, board walk, talk control, onboarding, auth, logs and backup | — |

Phase 2's first task enumerates every route on `main`, the upgrade paths included, and
classifies each one. The enumeration test (SC-001) keeps the table complete from then on.

### `mayHoldTodo` (FR-015, Q8-a)

`department-scope/assignee.ts` defines `mayHoldTodo(employee, rootDepartment)`. Its input is
always the department of the Todo's **root** (FR-002): every caller resolves the root first,
and no caller passes a sub-task's own column. It returns true when any of these holds:

- the employee is `@operator`;
- the employee is scoped, and the Todo is in its department;
- the employee is unscoped, or not on the roster, and the Todo's department is not
  `dedicated`.

A department's scope is its loaded scope, else its last good scope (`department_scopes`), else
`open`. A refused file with no last good scope counts as `dedicated`. If the store has no
resolver, it refuses nothing.

**Where it is enforced:** at the store, in every writer of `assignee`:

- the `createWorkItem` insert (`work-items/store.ts:356`);
- the two `releaseOnOwnerChange` update paths (`work-items/store.ts:797`, `:850`);
- `assignWorkItem`'s own `UPDATE` (`work-items/assignment.ts:98`).

The work-items layer does not know the roster. A resolver injected at gateway boot answers
"what is this employee's department, and what is that department's scope?" so the store can
decide. That covers every caller:

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

- a Todo's department change (the operator's metadata pen);
- a department's scope change through `PATCH /api/departments/:slug`;
- an employee's department change through `PATCH /api/org/employees/:name`.

A violation that comes from a hand edit to the YAML is reported by the org scan instead.

**First step of the task:** enumerate every `assignee` write in `work-items/`, and every
caller of those writers. Do not trust this list.

### Scoped MCP profile (FR-019)

`mcp/department-profile.ts` removes the tools whose routes are all refused:

- `list_cron_jobs`
- `get_cron_run_history`
- `cost_report`
- `send_connector_message`
- `list_files`
- `read_file`
- `create_label`
- `archive_work_item`

`list_departments` stays, and returns only D. Unscoped manifests are unchanged, and the
attested hash test proves it.

### Claude profile threading (FR-050 to FR-058)

`shared/claude-profile.ts` owns one type and four helpers:

- `ClaudeProfile = { dir: string; key: string } | null`, where `null` is the default profile;
- `resolveEmployeeClaudeProfile(employee)`: `null` unless the employee is local and sets
  `claudeConfigDir`;
- `claudeConfigDirFor(profile)` and `claudeJsonPathFor(profile)`, which return today's values
  for `null`;
- `claudeKeychainService(profile)`: `Claude Code-credentials`, plus `-<key>` for a named
  profile.

The value is resolved once per run from the employee and passed down. It reaches:

- **Environment**: `buildEngineChildEnv` takes the profile and sets `CLAUDE_CONFIG_DIR` for a
  named one. The call sites are the turn spawn, the idle PTY spawn and the redelivery
  respawn in `engines/claude-interactive.ts`, `sessions/turn/engine-run.ts`,
  `sessions/turn/rate-limit-turn.ts`, the rate-limit handler's retry, `gateway/pty-ws.ts`,
  `sessions/turn/auto-compact.ts`, and both forks in `sessions/fork.ts`.
- **Trust**: a lazy `seedTrust(claudeJsonPathFor(profile), cwd)`, cached per profile and cwd,
  before the first spawn.
- **Transcripts**: `findTranscriptForSession` takes the profile's projects directory. The
  callers are in `engines/claude-interactive.ts`, `gateway/external-turns.ts`,
  `gateway/api.ts` (`loadRawTranscript`, `loadTranscriptMessages`) and `sessions/fork.ts`. The
  api.ts readers already sit in a module that can be moved out to pay for the change.
- **Signed in**: `verifyLocalClaudeProfile(profile)`, called from `refuseTurn`. It checks the
  directory exists, then the Keychain entry by name on darwin
  (`security find-generic-password -s <service>`, exit status only, no `-w`), or
  `.credentials.json` elsewhere. Successes are cached.
- **Per-account state**: the auth outage scope, engine health, the rate-limit memory
  (`shared/usageAwareness.ts`) and the limits snapshot take the profile key. The default
  profile's keys are unchanged.
- **Fallback**: the rate-limit handler skips engine fallback and profile substitution for a
  named profile.
- **Settings** (FR-052a): for a named profile, `buildSessionSettings`
  (`shared/claude-settings.ts:70`) copies `attribution`, `hooks.PreToolUse` and
  `skipDangerousModePermissionPrompt` from the default profile's `settings.json`, merging
  `hooks` with the gateway's own.
- **Environment hygiene**: for a named profile, `CLAUDE_SECURESTORAGE_CONFIG_DIR` is removed
  from the child environment.
- **Canonical path**: `claudeConfigDir` is canonicalised once at load (no trailing slash, no
  `.` or `..`). The environment, the Keychain hash and the login hint all use that string.

The remote path gets the same treatment for `remoteClaudeConfigDir`: `engine-run.ts:55` passes
it, which fixes FR-058 for ordinary turns and auto-compaction. `rate-limit-turn.ts:166` passes
it too, although the rate-limit handler already rebuilds it from the employee.

## Phases

### Phase 1: departments carry a scope (junior-developer, then senior QA)

Senior QA, because it changes assignment for non-open departments.

**Backend**

- `gateway/department-registry.ts`: scan, validation (data-model.md), last good scopes in
  `department_scopes`, and `company:changed {entity:"department"}`. It runs with the org scan
  and the existing watcher.
- `work-items/department-scopes-schema.ts`: the table, registered in `V2_ADDITIVE_TABLES`.
- FR-003 in `departmentAfterAssignment`, and at the assign route so that `@operator` and
  engine-only delegates do not null a non-open department.
- FR-004 at create.
- FR-007's field-and-directory check in the org scan.
- `gateway/departments-api.ts`: the definition fields on `GET /api/departments`,
  `GET /api/departments/:slug`, and `PATCH /api/departments/:slug` (operator-only, atomic).
  Until Phase 2, `PATCH` refuses a non-open scope.
- `gateway/department-workdirs.ts`: FR-033.

**Web**

- `lib/department-api.ts` and the hook.
- Scope badges on the board switcher and on the org tree's department group.
- The department panel, opened from the org tree group, with an "Edit YAML" hint showing the
  file path.

**Visual**: `scripts/verify-departments.sh`, a Playwright config and a seed script, captured in
light and dark and attached to the PR.

### Phase 2: scoped employees (senior-developer; junior sub-Todos for the test matrix and the web; senior QA)

Senior, because it is the enforcement itself.

**Gateway**

- The scope resolver, injected at boot: an employee's department and that department's
  effective scope.
- `sessions.scope_department` and the binding in `spawnSession`. Connector sessions for scoped
  employees are refused.
- `gateway/department-scope/{caller,rules,read-routes,paths,assignee}.ts`, the gate line, and
  the upgrade-guard refusal.
- `mayHoldTodo` and the guard at every SQL writer of `assignee`, with the stranding refusals.
  Non-open scope writes through `PATCH /api/departments/:slug` are enabled here.
- FR-018 path checks. `list_files` and `read_file` are refused.
- `mcp/department-profile.ts`. It removes the refused tools and always includes the note tools,
  rooted at D's folder, even when `notesEnabled` is off.
- `JINN_DEPARTMENT` in scoped sessions' engine environment.
- `sessions/context/department-scope.ts`: a members-only roster and a department section.
- The `refuseTurn` lost-binding check.
- An `escalated` event when a Todo leaves D.
- Hidden counts.
- Cron validation, and claude-only, local-only validation for scoped employees.

**Web (junior sub-Todo)**

- Scope editing in the department panel, with the stranding refusal shown.
- Session badges in `SessionRow`, `mobile-session-row` and `TreeRow`.
- Light and dark screenshots of each.

**Tests (junior sub-Todo, from the table)**

- Route enumeration.
- An allow and a refuse case for every row.
- 404 bodies identical to an unknown id.
- `mayHoldTodo` at every writer and entry, including `dedicated`, `@operator` and the
  fallbacks (a refused file with and without a last good scope).
- FR-009 and FR-013.
- The SC-002 one-off comparison, recorded in the PR.

### Phase 3: scoped context (junior-developer, then senior QA)

The stage dir lives at `<parent of home>/.jinn-departments/<slug>/`.

- **Contents.** It holds copies of the allowed skills and a generated `CLAUDE.md`. The
  `CLAUDE.md` is built from `INSTRUCTIONS.md`, plus the company `CLAUDE.md` if
  `department+company` is set, plus the FR-029 scope paragraph.
- **Regeneration.** It is rebuilt on skill changes, on department scan changes and on
  instruction changes.
- **Use.** `engine-run.ts` uses it as the cwd for scoped sessions. A trust seed for the stage
  dir is written when the dir is generated, under the session's profile once Phase 4 exists.
- **Transcripts.** Resume, fork and auto-compaction resolve the stage-dir transcript slug.
  Each gets a regression test.
- **Skill allow-list.** It applies to the copies, the prompt and `dispatchConfig.skills`.
- **Notes.** `SEARCH_ROOTS` becomes a parameter. Scoped callers search the department folder,
  which includes `state.md`, plus `sharedNotes`. Note writes go only into the department
  folder.
- **Docs.** The template docs explain scoped departments, department state through the note
  tools, and the fact that this is a guardrail, not a sandbox. They do not mention `mem`, which
  is instance-local.

### Phase 4: per-employee Claude profiles (senior-developer; junior sub-Todo for the transcript readers and their tests; senior QA)

Senior, because it touches auth, engine health and every launch path.

- **First task:** confirm fact 4 with a throwaway profile on this Mac. List the Keychain
  service names, sign the throwaway profile in, and list them again. Record the result in the
  PR. Delete the throwaway entry afterwards.
- `claudeConfigDir` parsing and validation in `gateway/org.ts`, beside the remote check.
- `shared/claude-profile.ts` and the threading above, with a test per launch path (SC-003).
- The per-profile trust seed.
- The transcript readers (junior sub-Todo), each with a test that finds a transcript under a
  fake profile.
- `verifyLocalClaudeProfile` in `refuseTurn`, with the login hint.
- Per-profile keys for the auth outage ledger, engine health, the rate-limit memory and the
  limits snapshot, and the board walk reading the profile it is about to start (SC-006).
- No fallback for named profiles.
- FR-058, with a red test first.
- FR-052a, with a test per key.
- FR-059: refuse a named profile on a scoped employee until Phase 3's stage dir is in use. If
  Phase 3 has merged first, the check is "the stage dir is in use", not a flag.
- Web: the profile badge on the org tree and a read-only profile row in the employee panel.

## Delegation split

| Phase | Producer | Reviewer | Trigger |
| --- | --- | --- | --- |
| 1 | junior | senior QA | Specified, but it changes assignment for non-open departments |
| 2 | senior, with junior sub-Todos for the tests and the web | senior QA | Auth enforcement |
| 3 | junior | senior QA | Specified, but it decides what a scoped session can load |
| 4 | senior, with a junior sub-Todo for the transcript readers | senior QA | Auth, engine health and every launch path |

## Complexity Tracking

| Item | Why | Simpler alternative rejected because |
| --- | --- | --- |
| A last good scope in the registry | A typo or a deleted `department.yaml` must not open a scoped department | Reading only the file, which fails open on any edit mistake |
| Scope on the department, not on the employee | One department per employee means one scope per employee with no new field, and the board, prefix and org tree already exist | A separate project concept, which duplicates all three and needs its own rules on every route (research.md, "Found and rejected") |
| A second route table beside the connector's | The scoped principal differs from the connector in almost every row | One table with a principal column is harder to audit |
| A scoped read module instead of filters inside handlers | Handlers are over budget and have unfiltered branches (`ids=`, `pinned`, `q`) | Threading `department` through every branch is where a missed branch leaks |
| A stage dir outside the home, with copied skills | Claude loads the ancestor `CLAUDE.md`, and the shared skills dir sits under the home | A prompt-only "do not use skill X" is not a restriction |
| One `ClaudeProfile` value threaded from the employee | About fifteen places assume one profile today | Setting `CLAUDE_CONFIG_DIR` in the environment only, which leaves transcripts, trust, auth and health reading the wrong account |
