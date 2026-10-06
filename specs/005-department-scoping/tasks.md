# Tasks: Department-Scoped Employees and Per-Employee Claude Profiles

These tasks follow the operator's decisions (spec.md, "Operator decisions").

## How the work ships

**Order.** Each phase is its own PR off `main`. Phases 1 → 2 → 3 → 5 are built in order.
Phase 4 is independent and may run alongside them. Phase 6 follows Phase 4.

**Rules for every phase.**

- Re-verify the plan's `path:line` rows before starting.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` locally. The repo has no
  running CI, so say in the PR that verification was local.
- Do not grow any file that is at or over its size budget.
- Commits, branch names and PRs use no internal tracking numbers.
- **Docs** (FR-043): update the template docs and skills, and the repository docs, that the
  change affects, in the same PR.
- **Instance migration** (FR-044): if anything under `packages/jinn/template/` changed, run
  `pnpm --filter jinn-cli migration:generate -- --base-ref <latest release tag> --version <next version> --allow-unreleased`,
  add this phase's paragraph to the release rationale, and pass the same command with
  `migration:check`. If another phase merged first, rebase and regenerate.

**Visual evidence** (FR-045). Every UI task captures screenshots with the sandbox gateway
script from T031: light and dark, desktop and phone widths, and every state the element has.
The screenshots go on the PR, and senior QA reviews them as part of the review.

`[P]` means the task can run in parallel with others in its phase.

## Phase 1: departments carry a scope (junior-developer, then senior QA)

### Backend

- [ ] T020 Write a red test first: on `main`, assigning a Todo in department `side-project` to
  an Engineering employee moves it to Engineering.
- [ ] T021 Write `gateway/department-registry.ts`.
  - It reads every `org/<slug>/department.yaml` with the parser `org.ts` uses, during the org
    scan, so the existing `org/` watcher (`gateway/watcher.ts:130`) covers it.
  - It applies data-model.md's scan rules: identity problems refuse the file and keep the last
    good scope; content problems drop only the entry; a refused file with no last good scope
    counts as `dedicated`; a missing file keeps the last good scope, else `open`.
  - It upserts `department_scopes` on every successful load.
  - It emits `company:changed {entity:"department"}`.
- [ ] T022 Write `work-items/department-scopes-schema.ts`, defining `department_scopes` per
  data-model.md, registered in `V2_ADDITIVE_TABLES` and `REQUIRED_TABLE_SQL`.
- [ ] T023 Apply FR-003 and FR-004, always judging by the root's department (FR-002):
  - `departmentAfterAssignment` (`work-items/assignment.ts:72`) keeps a non-open department;
  - the assign route (`gateway/api.ts:2650`) no longer nulls a non-open department for
    `@operator` or an engine-only delegate;
  - delegation's create and assign paths (`gateway/api.ts:3461`, `:3501`) keep a non-open
    department;
  - a create under a root in a non-open department, or naming a non-open department under a
    root elsewhere, is refused unless the departments match. The check lives in
    `createWorkItem`, so plugin and cron creates are covered.

  The work-items layer learns scope from a resolver injected at boot. With none injected,
  every department is open.
- [ ] T024 FR-007 in the org scan: read scope from the top-level directory under `org/`, and
  refuse an employee when that directory, its immediate directory or its `department` field
  disagree and any of them is a non-open department. Log why, beside the remote-target check
  at `gateway/org.ts:112`. Report sub-tasks whose own department differs from a non-open
  root's; that check lives in `department-registry.ts`, which reads the work-items registry,
  not in the org scan. Warn on a near-miss file name such as `department.yml`.
- [ ] T025 Write `gateway/departments-api.ts`:
  - the definition fields on `GET /api/departments` (data-model.md, "Wire shapes");
  - `GET /api/departments/:slug`;
  - `PATCH /api/departments/:slug`, which rewrites or creates that `department.yaml`
    atomically (temp file, then rename) and refreshes the definitions before it responds.
    Until Phase 2, it refuses a non-open `scope`.

  Writes are operator-only (`control-plane-routes.ts`). Mount the module with one line in
  `api.ts`, and pay for that line and T023's by moving `GET /api/sessions`
  (`gateway/api.ts:1743`) into `gateway/sessions-list-api.ts`.
- [ ] T026 Write `gateway/department-workdirs.ts` for FR-033.
- [ ] T027 Tests:
  - scan rules: one case per identity refusal; a content problem drops only the entry; a
    broken edit keeps the last good scope; a deleted file keeps it; a brand-new refused file
    counts as `dedicated`; `scope: open` opens a department;
  - no `department.yaml` anywhere: everything is open and nothing is logged;
  - T020 turns green, plus `@operator`, engine-only delegates, delegation and sub-tasks;
  - open departments keep today's assignment behaviour;
  - the FR-007 mismatch refusal;
  - FR-033: each protected tree, an ancestor of `$HOME`, a non-git work root, and a dotfiles
    home;
  - YAML written by `PATCH` round-trips through the scan.

### Web

- [ ] T028 [P] Write `lib/department-api.ts` and its hook, and wire query invalidation on
  `company:changed {entity:"department"}`.
- [ ] T029 [P] Show the scope badge on the board switcher rows and on the org tree's
  department group box. Open departments show none.
- [ ] T030 [P] Build the department panel, opened from the org tree group: details, scope
  (read-only until Phase 2), working directories, skills, shared Notes, instructions mode,
  members, and an "Edit YAML" hint with the file path. Show `definitionError` when the file
  was refused.
- [ ] T031 Write `scripts/verify-departments.sh`, a Playwright config and a seed script,
  following the chat-grid-drop sandbox pattern. Capture T029 and T030 in light and dark.
- [ ] T032 Docs and migration: `docs/org.md` and the `management` skill describe
  `department.yaml`, `scope` and the department panel. Generate the instance migration bundle
  and write Phase 1's rationale paragraph (FR-043, FR-044).

## Phase 2: scoped employees (senior-developer, then senior QA; T048 and T049 go to the junior as their own Todos)

- [ ] T040 Enumerate every API route on `main` and every upgrade path, and classify each
  against plan.md's table. Write the route-enumeration test.
- [ ] T041 Inject the scope resolver at boot: an employee's department and that department's
  effective scope. Validation: a scoped employee is claude-only (FR-026), a scoped employee
  with a `remoteHost` is refused with the reason until Phase 5 lifts it, and no cron job may
  target one.
- [ ] T042 Add `sessions.scope_department`, set only for scoped employees in `spawnSession` by
  FR-008. Use `parent_session_id` as the FR-013 requester. Refuse connector-originated
  sessions for scoped employees.
- [ ] T043 Write `gateway/department-scope/{caller,rules,paths}.ts`. Add the gate line beside
  `gateway/api.ts:1181` and the scoped refusal in `gateway/upgrade-guards.ts`.
- [ ] T044 Write `gateway/department-scope/read-routes.ts` for every scoped list and search
  row, including the `ids=`, `pinned` and `q` branches and the hidden counts.
- [ ] T045 Write `mayHoldTodo` (FR-015).
  - Add a guard at every SQL writer of `assignee`. Enumerate them first with
    `git grep -n "SET assignee\|assignee = ?\|INSERT INTO work_items" packages/jinn/src`.
    On `main` that finds the `store.ts` insert, the two dynamic update paths in `store.ts`, and
    `work-items/assignment.ts:98`. Then enumerate their callers, including
    `cron/runner.ts:101`, `plugins/host/todos.ts:31` and `gateway/api.ts:3450`.
  - Check entry points: `spawnSession` with a linked Todo, Dispatcher routing, and the
    board-walk projection (which skips).
  - Refuse the stranding transitions and name the holders: a Todo's department change, a
    department scope change, and an employee's department change. Enable non-open scope
    writes in `PATCH /api/departments/:slug`.
  - The org scan reports violations created by hand-edited YAML.
- [ ] T046 Apply FR-018 path checks, for scoped callers only, in the two MCP tools that read a
  path themselves (`publish_attachment` and `uploadWorkItemAttachment`, with roots from the
  scoped session's MCP config) and at the gate for the JSON `{path}` attachment route. Test
  each tool. Refuse `list_files` and `read_file`.
- [ ] T047 Write `mcp/department-profile.ts` and its resolver selection. The profile removes
  the refused tools, and always includes the note tools rooted at D, even when `notesEnabled`
  is off. Serve the note routes to scoped callers regardless of that flag
  (`gateway/api.ts:1207`). Set `JINN_DEPARTMENT` in scoped sessions' environment. Then:
  - write `sessions/context/department-scope.ts`, covering the members-only roster and the
    department section, and pay for its call site in `context.ts`;
  - add a lost-binding check to `refuseTurn`;
  - write an `escalated` event when a Todo leaves D.
- [ ] T048 Tests (junior sub-Todo):
  - an allow and a refuse case for every table row, as a capability-bound scoped session
    against a seeded home;
  - 404 bodies identical to those for unknown ids;
  - `mayHoldTodo` at every writer and entry, covering `dedicated`, `@operator`, the last good
    scope fallbacks and the stranding refusals;
  - FR-009: a scoped caller can neither see nor message an unscoped session working a D Todo;
  - FR-013: a reply to `parent_session_id` succeeds, and other sends outside D are refused;
  - unscoped callers are unchanged by FR-018.

  Record the SC-002 one-off comparison in the PR.
- [ ] T049 [P] Web (junior sub-Todo):
  - scope editing in the department panel, with the stranding refusal shown;
  - session badges in `SessionRow`, `mobile-session-row` and `TreeRow`.

  Capture each in light and dark.
- [ ] T050 Docs and migration: `docs/org.md`, `docs/company-doctrine.md` and the
  `todo-handling` and `delegation` skills describe what a scoped employee can and cannot
  reach, `dedicated`, and the assignment rules. Add Phase 2's rationale paragraph (FR-043,
  FR-044).

## Phase 3: scoped context (junior-developer, then senior QA; starts after Phase 2 merges)

- [ ] T060 Generate the stage dir at `<parent of home>/.jinn-departments/<slug>/`. It contains
  copies of the allowed skills and a `CLAUDE.md` built from `INSTRUCTIONS.md`, plus the
  company file if `department+company` is set, plus the FR-029 scope paragraph. Sync it by
  FR-020a (stable path and inode; changed files renamed in from an incoming directory beside
  it; extras removed afterwards) on skill, department-scan and instruction changes and before
  every scoped spawn, file by file (only files are renamed; directories are made with
  `mkdir -p`). Refuse a skill containing a symlink. Test that the inode is unchanged, that a
  session's edit is reverted, and that a kept skill that changed and lost a file syncs.
  Use it as cwd for scoped sessions in `engine-run.ts`. Write a trust seed for the stage dir
  when it is generated (under the session's profile, if Phase 4 has merged). The generator
  returns the file set without writing it, so Phase 5 syncs the same content.
- [ ] T061 Make resume, fork and auto-compaction resolve the stage-dir transcript slug. Add a
  regression test for each.
- [ ] T061a Add the local cwd helper (FR-020b) and use it at `engine-run.ts:46`,
  `rate-limit-handler.ts:185` and `:301`, and `pty-ws.ts:139`. Add the grep test for
  `cwd: JINN_HOME` at session-spawn sites, with its allow-list. Make scoped sessions skip
  engine fallback entries (FR-026a). Test a scoped session's Branch B retry, its terminal
  attach, and a rate limit with `engines.claude.fallback: [codex]` (it waits).
- [ ] T062 Apply the skill allow-list to the copies, the prompt and `dispatchConfig.skills`.
- [ ] T063 Make `SEARCH_ROOTS` a parameter. For scoped callers:
  - root reads at `knowledge/departments/<slug>/` (including `state.md`) plus `sharedNotes`;
  - refuse the company `knowledge/state.md`, `knowledge/employees/` and `docs/` unless they
    are shared;
  - allow note writes only in the department folder.
- [ ] T064 Docs and migration (FR-043, FR-044; add Phase 3's rationale paragraph). Update the template docs (`todo-handling`, `management`, `docs/org.md`). Cover:
  - `department.yaml` and its `scope`;
  - department state in `knowledge/departments/<slug>/state.md`, kept through the note tools;
  - the fact that scoping is a guardrail, not a sandbox.

  Do not mention `mem`, which is instance-local. Add a migration note if instance files
  change.

## Phase 4: per-employee Claude profiles (senior-developer, then senior QA; T074 goes to the junior as its own Todo)

- [ ] T070 Confirm fact 4 on this Mac with a throwaway profile: list the Keychain service names,
  sign the throwaway profile in, list them again, and record the result in the PR. Repeat with
  the same directory spelled with a trailing slash. Then write red tests: an employee with
  `claudeConfigDir` spawns without `CLAUDE_CONFIG_DIR`, and a remote employee's ordinary turn
  drops `remoteClaudeConfigDir` (`sessions/turn/engine-run.ts:55`).
- [ ] T071 Parse and validate `claudeConfigDir` in `gateway/org.ts` beside the remote check
  (FR-050). Refuse it with `remoteHost`. Apply no scope check (FR-059): a test pins that a
  scoped and an unscoped employee both spawn on their profile. Add every `claudeConfigDir` to
  the file-read policy's protected Claude dirs.
- [ ] T072 Write `shared/claude-profile.ts` (plan.md, "Claude profile threading"). Thread the
  profile through `buildEngineChildEnv` and every launch path in FR-051, with a test per path
  (SC-003). Pass `remoteClaudeConfigDir` on the remote paths (FR-058).
- [ ] T073 Seed trust lazily per profile and cwd before the first spawn (FR-052). Carry
  `attribution`, `hooks.PreToolUse` and `skipDangerousModePermissionPrompt` into the session
  settings for named profiles, with a test per key (FR-052a). Remove an inherited
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` for named profiles.
- [ ] T073a Verify FR-052a end to end. Run a real session on the throwaway profile with the
  gateway-built `--settings`, and record in the PR that: (1) the bypass-consent dialog does not
  appear with FR-052a (and whether it appears without it); (2) a commit and a PR body made in
  that session carry no Co-Authored-By or "Generated with" line, using a scratch repository or
  a dry run, never a real PR on a client repository; (3) the PreToolUse hook fires. For any key
  that fails, apply FR-052a's fallback (write it into `<profile>/settings.json` and add it to
  the FR-054 check) and record the re-run. Delete the throwaway Keychain entries afterwards.
- [ ] T074 Transcript readers (junior sub-Todo): give `findTranscriptForSession` and every
  FR-053 reader the session's profile, with a test per reader that finds a transcript under a
  fake profile.
- [ ] T075 Write `verifyLocalClaudeProfile` and call it from `refuseTurn` (FR-054). The
  Keychain probe is injectable, checks by service name and exit status only, and never reads
  the secret.
- [ ] T076 Write `shared/engine-account.ts` for local accounts (FR-070). Restrict every
  reader of the shared status-line directory (the Limits card, `engine-reset-times.ts`, the
  usage history, the walk) to default-account sessions, with a test that a newer named-profile
  snapshot changes neither the default reading nor the reset time (FR-055). Key the auth
  outage ledger, engine health and the rate-limit memory per account,
  leaving the default profile's keys unchanged (FR-055). The limits reading and the board walk
  are Phase 6. Skip fallback and substitution for named profiles (FR-056). Test SC-006.
- [ ] T077 Web: the profile badge on the org tree and a read-only profile row in the employee
  panel. Capture both, and the "not signed in" refusal in chat, in light and dark.
- [ ] T078 Docs and migration (FR-043, FR-044; add Phase 4's rationale paragraph, including how to opt in): how to create and sign in a profile, what goes to its account (including the
  profile's own skills, plugins and connectors). Say plainly that a profile is independent of
  department scope, so an unscoped employee on a profile sends company context to that
  account (FR-059).

## Phase 5: scoped employees on remote hosts (senior-developer, then senior QA; starts after Phase 3 merges; T084 goes to the junior as its own Todo)

- [ ] T080 Red test: on `main`, a scoped remote employee (Phase 2's refusal bypassed in the
  test) gets a session home linking the company home, and the company `CLAUDE.md` linked into
  its `remoteCwd`.
- [ ] T081 Write `engines/remote-department-stage.ts`: before every scoped spawn on a host,
  send Phase 3's file set as a tar stream over `sshRun` into
  `<remote.root>/.jinn-departments/.<slug>.incoming-<random>/`, then run a sync script that
  applies FR-020a (rename changed files over the old ones, remove extras, delete the incoming
  directory) file by file: rename only files, `mkdir -p` directories, remove type changes
  first, remove extras including files gone from a kept skill, and reap stale incoming dirs.
  Never replace the stage dir. Keep no hash cache (FR-060).
- [ ] T082 Give `prepareRemoteSession` an optional department. Under `serializePerHost`, run in
  this order: a scoped farm script, assets, the sync, then the trust seed for the remote stage
  dir. The scoped farm script keeps reaping, the per-session lock, the marker, the real `tmp/`
  and the `asset=` report, and makes no mount links and no `CLAUDE.md` link. Before writing
  anything, refuse a `remoteCwd` that is, contains or lies inside `facts.stageDir`, failing
  closed without facts. Add `JINN_DEPARTMENT` to the environment file. Leave `FARM_SCRIPT`
  untouched (FR-061 to FR-064).
- [ ] T083 Give `employeeRemoteTarget` the scope resolver as a required argument, returning the
  remote stage dir as `remoteCwd` for a scoped employee. Move `engine-run.ts:55` onto it and
  update every caller the compiler lists. Move the rate-limit handler's inline target and
  `rate-limit-turn.ts:168`'s raw `remoteCwd` onto it by hand, since the compiler does not flag
  them; a scoped retry with no employee record is refused. Add the grep test that fails on any
  other read of an employee's `remoteCwd` outside `remote-target.ts` (FR-061 names every
  caller). Put the employee's own
  `remoteCwd` in the scoped prompt section as the work area. In `gateway/org.ts`, refuse a
  scoped employee's `remoteCwd` that is, contains or lies inside
  `<remote.root>/.jinn-departments` or `remote.mount`, and remove Phase 2's refusal of scoped
  remote employees (FR-026, FR-061).
- [ ] T084 Tests (junior sub-Todo), as listed in plan.md Phase 5: cwd and `JINN_DEPARTMENT` per
  `employeeRemoteTarget` caller, the rate-limit retry included; the scoped farm script and the sync script under `sh` against
  temporary directories (no mount link, no `CLAUDE.md`, `asset=` report present, inode
  unchanged, dropped skill removed, edited file restored, a kept skill that changed and lost a
  file, a path that changed type, a stale incoming dir reaped); the stage-root refusal; a byte
  comparison of the unscoped scripts and argv against `main` (SC-007).
- [ ] T085 Apply the FR-018 limit in both remote tools, `publish_attachment` and
  `uploadWorkItemAttachment`, against the employee's `remoteCwd` and the remote stage dir from
  the staged MCP config, with a test for each. Refuse the gateway's JSON `{path}` route for
  remote scoped sessions (FR-065).
- [ ] T086 Live check. This instance has no `remote` block. If the operator provides a remote
  host, run one scoped session there and record the result in the PR. Otherwise say in the PR
  that the remote path is verified by tests only.
- [ ] T087 Docs and migration (FR-043, FR-044; add Phase 5's rationale paragraph): scoped employees on remote hosts, and the fact that the remote shell can still
  reach the mounted home (a guardrail, not a sandbox).

## Phase 6: limits and auto-dispatch per account (senior-developer, then senior QA; starts after Phase 4 merges; T094 goes to the junior as its own Todo)

- [ ] T090 Red test: with two local Claude accounts, a rate limit on the named one marks Claude
  exhausted for the walk, and `/api/engine-limits` has one Claude slot.
- [ ] T091 Extend `shared/engine-account.ts` (begun in Phase 4 for local accounts) to remote
  accounts (FR-070), so health, the rate-limit memory and the outage ledger key remote
  sessions on their own account.
- [ ] T092 Read limits per local account (FR-071): the token reader with an account argument
  (the model catalog keeps the default), `claude auth status` with the profile's
  `CLAUDE_CONFIG_DIR`, snapshots filtered by account, and reset times and usage history per
  account. `collectEngineLimits` and the background refresh loop over the roster's accounts.
  Test that the token never reaches a log, a file or a child environment, that a named
  account's read skips `$CLAUDE_CODE_OAUTH_TOKEN`, and that nothing refreshes a token. Check
  once, on T070's throwaway profile, that reading the suffixed Keychain entry with
  `security -w` does not prompt, and record it in the PR.
- [ ] T092a Remote readings (FR-072): on the host, with its Node, parse `.credentials.json` (or
  read the Keychain entry named for that path on a macOS host) and print only the access token
  and its expiry. Run `claude auth status` over SSH, only when the host is reachable. Keep the
  token in memory for the one call. Test that the captured output holds no refresh token, that
  nothing stores or logs the token, that nothing wakes a host, and that a sleeping host shows
  its last reading and its age.
- [ ] T093 Board walk (FR-075 to FR-077): per-account snapshot fields and `priorFiveHour`,
  candidate accounts, the `startTodo` code gate, exhausted accounts in `dispatcherSuffix`,
  the per-account rewrite of `template/board-walk.md`, the `noReading` flag with one probing
  start (FR-075a), and no change to the runner's own fallback (FR-076). Document the
  unrouted-Todo limit (FR-075), and that a probe whose session ends before its token is
  refreshed leaves the account unread, so it may be probed again on a later tick (at most one
  start per tick per account).
- [ ] T093a Per-account fallback chains (FR-079): parse and validate `engines.claude.accounts`,
  let chain entries name accounts, walk them with per-account health, and run an account
  substitute as a fresh session on that profile with the recent history. Validate duplicate
  and default `configDir`s and FR-050 failures, and resolve names to FR-070 keys. Track
  substitution by account: the override records both accounts, `engineSessions` is keyed by
  account (`claude` unchanged for the default), and the profile resolver honours the override
  until `until`. Test:
  - a declared account with `fallback: []` waits;
  - one with `[claude, codex]` moves to the default account, or to codex when the default
    account is exhausted;
  - a second turn inside the override window runs on the substitute account and resumes its
    thread, and after `until` the session is back on its own account and thread;
  - renaming an account in config keeps its health and history;
  - a scoped session accepts only account entries and keeps its stage dir;
  - a board-walk turn is never substituted;
  - an undeclared local named profile never inherits `engines.claude.fallback`, and a remote
    employee behaves as on `main`.
- [ ] T094 Web (junior sub-Todo): `accounts` on `/api/engine-limits` with `engines.claude`
  unchanged, the Limits page grouped by engine, `/api/auto-dispatch/usage?account=`, and the
  usage card's switcher. Capture every FR-040 limits state (FR-045).
- [ ] T095 Test SC-009 and FR-078: on a fixed clock and fixtures, a byte comparison against
  `main` of the snapshot JSON, the `dispatcherSuffix` text and the limits response for a
  single-account roster (`accounts` omitted); the walk prompt with the same `board-walk.md`
  on both sides; and a decision-level test of the walk's choices.
- [ ] T096 Docs and migration: `docs/architecture.md` and the Limits and Auto-Dispatch docs
  describe accounts and their fallback chains, including that putting `claude:<name>` in
  `engines.claude.fallback` moves the default account's unscoped company sessions onto that
  account. The rationale tells an instance to reconcile its own `board-walk.md` to
  the per-account wording (FR-077), and adds Phase 6's paragraph (FR-044).

## Follow-ups outside this feature

- [ ] F1 (instance, not this repository) Make `~/.jinn/bin/mem` respect `JINN_DEPARTMENT`, so
  it defaults to `departments/<slug>/state.md` and refuses other files.
