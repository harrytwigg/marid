# Research: Projects and Project-Scoped Employees

Read against `origin/main` at `60e675d6`. Paths are relative to `packages/jinn/src/` unless
they start with `packages/`.

**After the operator's decisions (2026-10-05):**

- Q1 = A: no sandbox in this feature.
- Q6 = b: existing employees read as today.

So the "Local file reads" rows and the "Containment" section below stay as findings, but
nothing in this feature acts on them. They apply only to scoped callers (FR-018, FR-028), or
they belong to the future sandbox work. Phase S, Phase 0 and the old containment Phase 4 are
withdrawn.

## What already exists (constitution Principle VII)

### Data model

| `path:line` | What it is | Bearing on this feature |
| --- | --- | --- |
| `work-items/sprints-schema.ts:5` | "Additive tables, never columns on `work_items`" | The project dimension is a join table, as sprints are |
| `work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`: tables created at boot when missing | `work_item_projects` and `project_ids_seen` are registered here. Project definitions are YAML, so there is no `projects` table |
| `work-items/sprints-schema.ts:60` | `sprintFilterCondition` filters on the **root's** membership (`root_id`) | Same shape for `project=<id>\|none`. Sub-tasks inherit their project for free |
| `work-items/sprint-membership.ts:71` | `assertTopLevel`: only roots hold a sprint | Same rule for projects (FR-004) |
| `work-items/store.ts:511` | The list filter applies `sprint` | `project` goes next to it |
| `work-items/store.ts:331` | The id prefix comes from the department | Unchanged: a project does not affect numbering |
| `work-items/migrate.ts:161` | `labels.department` is nullable, and null means company-wide | Precedent for a nullable scope column on a registry row |
| `sessions/migrate.ts:342` | Sessions use add-column-if-missing | `sessions.project_id` is a plain added column. The FR-013 requester reuses `parent_session_id` (`sessions/migrate.ts:26`) |
| `sessions/migrate.ts:117` | The `files` table has no session or owner column | Managed files cannot be scoped, so FR-018 refuses them for scoped callers |
| `shared/types.ts:515` | `Employee` | Gains an explicit project scope (FR-007) |
| `shared/types.ts:529` | `mcp` allow-list, the only per-employee allow-list today | Precedent for an optional list field on the employee |
| `gateway/org.ts:78` | Maps YAML to `Employee` fields | Reads `projects` |
| `gateway/org.ts:170` | `WRITABLE_FIELDS` for `PATCH /api/org/employees/:name` | Gains `projects` |
| `gateway/api.ts:2187` | Create refuses `assignee` | There is no create-with-assignee path |
| `gateway/api.ts:2192` | `parentId` is accepted only at create | There is no re-parent path |

### Identity and authentication

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `mcp/identity.ts:143` | `deriveSessionCapability`: an HMAC of the session id under the capability key in the secrets directory | A scoped caller is identified exactly as today |
| `mcp/identity.ts:162` | `verifySessionCapability` | Unchanged |
| `mcp/identity.ts:42` | "defense-in-depth … not an internet auth boundary" | Why Q1 exists |
| `mcp/server-bootstrap.ts:25` | The MCP server **derives** the capability itself from the key file, given only a session id and a home on argv | Any process that can read the key can mint any session's capability. Deferred to the sandbox work |
| `mcp/server.ts:39` | `resolveServerToken`: the MCP server authenticates with the bearer token from its environment or from `gateway.json` | Deferred, not built: in a future sandbox this server would keep working while the shell could not read `gateway.json` |
| `gateway/request-handler.ts:55` | With `authRequired`, a request without the bearer token gets 401 before any route, except the exempt set |
| `gateway/auth.ts:250` | `authRequiredForRequest` exempts `/api/status`, `GET /api/auth/state`, the `POST` auth and pairing routes, and `POST /api/internal/hook` | E15 walks these |
| `gateway/server.ts:1035` | Upgrades: `/ws` and plugin events refuse unidentified callers, then check auth. Only `/ws/pty` is operator-only | A token-holding session receives the company broadcast today |
| `mcp/identity.ts:207` | Each jinn MCP server gets `JINN_SESSION_CAPABILITY` in its environment | Visible to `ps -E` from any same-user process. Seen on this host in 6 of 6 running MCP servers |
| `gateway/server.ts:510` | `process.env.JINN_GATEWAY_TOKEN` is set in the gateway and inherited by every engine | Visible to `ps -E`. Seen on this host in 148 processes |
| `packages/jinn/assets/hook-relay.mjs:10` | The hook relay resolves its home from `JINN_HOME` or `~/.jinn` | FR-025a | This instance runs `authRequired: true`. Deferred, not built: a contained shell would stop here |
| `gateway/auth.ts:264` | `shouldRequireGatewayAuth`: auth is off on loopback unless `gateway.authRequired` is set | Deferred to the sandbox work |
| `gateway/api.ts:841` | `rejectUnverifiedIdentifiedApiCaller` lets unauthenticated `GET`s through when auth is off | Affects auth-off instances only |
| `gateway/api.ts:796` | Same-origin browser inference, purely from headers | On an auth-off instance any local `curl` can forge it. Deferred to the sandbox work |
| `gateway/session-comm-guards.ts:333` | `resolveCallerIdentity`: one of operator, session, unidentified-tool or unauthenticated | The scope check reads the session from here |
| `gateway/api.ts:603` | `resolveScopedWriteCallerIdentity` | Same |

### Enforcement points

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `gateway/api.ts:1181` | `refuseRemoteMcpRoute` at the identified-caller gate | **The precedent:** a per-principal route allow-list enforced in one place. The scoped gate goes beside it |
| `gateway/remote-mcp/rules.ts:25` | `ALLOWED_ROUTES`, the connector's allow-list | Shape copied for `gateway/project-scope/rules.ts` |
| `gateway/api.ts:1212` | `operatorOnlyControlPlaneRoute` | Already refuses config, cron and org writes to every non-operator |
| `gateway/control-plane-routes.ts:12` | The operator-only route table | Same |
| `gateway/upgrade-guards.ts` (imported at `gateway/server.ts:62`) | WebSocket upgrade guards | Scoped callers are refused here. Upgrades never reach `handleApiRequest` |
| `gateway/api.ts:530` | `resolveWorkItemCaller` | The per-Todo check |
| `gateway/work-item-authority.ts:25` | `hasStandingOverWorkItem`: the org root, the owner, or a manager above the owner | Scope is checked **before** standing. Standing is never widened |
| `gateway/work-item-standing.ts:20` | `mayRetagTodo` | Who may change a Todo's project: the same people who may change its sprint |
| `gateway/api.ts:2148` | `GET /api/work-items?ids=` returns the Todos it names, unfiltered | The scoped read module covers this branch |
| `gateway/api.ts:2171` | The query form calls `queryWorkItems` | Same |
| `gateway/api.ts:1744` | `GET /api/sessions` has `pinned` and `q` branches | Same |
| `gateway/api.ts:3273` | `POST /api/delegations` | FR-016 target check |
| `gateway/api.ts:3640` | `POST /api/sessions` (spawn) | FR-016, and the FR-008 binding |
| `gateway/spawn-session.ts:163` | `spawnSession`, where every spawn path converges | Sets the binding, once. `parentSessionId` (`:188`) is the requester |
| `gateway/api.ts:3695` | `POST /api/sessions/:id/message` | FR-012 and FR-013 |
| `gateway/api.ts:905` | `resolveSpawnParentSessionId` accepts any existing session as parent | Scoped callers may name only a P-bound parent |
| `work-items/assignment.ts:77` | `assignWorkItem`. Callers: `gateway/api.ts:2650` (assign), `gateway/api.ts:3501` (delegation), `talk/control/todo-adapters.ts:132`, `talk/control/delegation-adapter.ts:107` | Covered by the store-level check |
| `gateway/api.ts:2409` | PATCH sets `assignee` directly, without `assignWorkItem` | Covered by the store-level check |
| `gateway/api.ts:3450` | Delegation with no existing Todo creates one already assigned | Covered by the store-level check |
| `plugins/host/todos.ts:31` | A plugin create passes `draft.assignee` and `parentId` | Covered by the store-level check |
| `work-items/store.ts:356`, `:797`, `:850` | Every writer of `assignee` (`:961` says so) | **Where `mayHoldTodo` lives** |
| `gateway/todo-assignee.ts:21` | `checkAssignee` accepts `@operator` | `mayHoldTodo` admits `@operator` |
| `gateway/todo-dispatch.ts:197` | `startTodoDispatcher` (dispatch and board walk) | Routing check |
| `gateway/self-compaction-api.ts:217` | `POST /api/compactions` | Own session only |
| `gateway/todo-capture-api.ts:172` | `capture-landing` (`land_on_work_item`) | Todo must be in P |
| `gateway/search-api.ts:240` | `/api/search/global` | Refused for scoped callers |
| `gateway/api.ts:1681` / `:1694` | Knowledge search and read routes | Rooted per FR-028 |
| `notes/store.ts:613` | `SEARCH_ROOTS = ["knowledge", "docs"]` | Becomes a parameter |
| `mcp/server.ts:112` | `buildTools` | Scoped sessions get a filtered profile |
| `gateway/remote-mcp/profile.ts:98` | The connector's tool filter | Precedent for a per-principal profile |

### Local file reads (FR-018 for scoped callers; unchanged for everyone else, Q6 = b)

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `notes/store.ts:729` | `readKnowledgeFile` checks only that the path is inside the home | It can read `gateway.json` (the operator bearer token), the secrets directory, `config.yaml`, `tmp/mcp/*` and `auth-devices.json` |
| `shared/file-read-policy.ts:58` | `assessFileRead` refuses the secrets directory. It is used only by `/api/files/read` and attachments | Q6-a routes `read_knowledge` through it |
| `shared/protected-home-entries.ts:46` | `config.yaml` is a protected entry | So under Q6-a, `read_knowledge` can no longer read `config.yaml` |
| `gateway/__tests__/knowledge-route.test.ts:155` | Asserts that `config.yaml` **is** readable through `read_knowledge` | Changes under Q6-a |
| `mcp/__tests__/knowledge-tools.test.ts:152` | Stubbed test: the tool forwards any relative path and "leaves containment to the gateway" | Unaffected, because the refusal happens in the gateway |
| `mcp/file-tools.ts:96` | `publish_attachment` accepts any absolute path to a regular file up to 50 MB | Q6, plus the FR-018 workdir check |
| `mcp/work-item-attachments.ts:68` | Path-based `attach_to_work_item`, through `readLocalFileForIngestion` | The policy does not protect `registry.db`, `org/`, `CLAUDE.md`, or other projects' directories. FR-018 |
| `gateway/api.ts:2925` | JSON `{path}` attachment ingestion, read inside the gateway | Same |

### Engine spawning

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `sessions/turn/engine-run.ts:46` | Local engines always run with `cwd: JINN_HOME` | FR-020: scoped sessions get the stage dir |
| `gateway/server.ts:504` | Exports `JINN_GATEWAY_TOKEN` to every engine | FR-021 |
| `shared/child-env.ts:41` | `buildEngineChildEnv` passes on `process.env` minus a short deny list | Deferred, not built: an allow-list builder |
| `engines/claude-interactive.ts:451` | Claude argv: `--chrome` (`:451`, the operator's own browser), `--dangerously-skip-permissions` (`:454`), the gateway-written `--settings` under `tmp/` (`:456`), and `--mcp-config` without `--strict-mcp-config` (`:459`) | Deferred to the sandbox work |
| `shared/claude-settings.ts:70` | `buildSessionSettings` writes hooks and a status line only | Deferred, not built: sandbox and deny blocks |
| `board-walk/route-turn.ts:48` | `CLAUDE_WALK_FLAGS`: `--no-chrome --tools "" --strict-mcp-config` | The only existing locked-down Claude turn |
| `gateway/watcher.ts:38` | `syncSkillSymlinks` links every skill into `~/.jinn/.claude/skills` | The stage dir gets copies of the allowed skills instead |
| `work-items/dispatch-config.ts:253` | `resolveTodoDispatch` adds skills as prompt lines | FR-027 validates them against the allow-list |
| `sessions/context.ts:198` | `buildContext` | The project section comes from a new module |
| `sessions/context.ts:298` | Working roster | Filtered to members |
| `sessions/context.ts:345` | Knowledge section | Points at the project Notes root |
| `sessions/turn/preflight.ts:52` | `refuseTurn`, the gate before every engine spawn | Lost binding, wrong engine |
| `sessions/turn/preflight.ts:63` | Per-employee monthly budget check | Already a per-project cap for dedicated employees |
| `sessions/fork.ts:164` / `engines/claude-interactive.ts:271` | Transcripts are keyed by the cwd slug | Resume, fork and compaction must resolve the stage-dir slug |
| `shared/claude-settings.ts:124` | Trust entries per directory in `~/.claude.json` | The only seed today is boot-time (`gateway/server.ts:565`). Phase 3 adds one per stage dir |
| `shared/home.ts:34` | `resolveClaudeConfigDir` reads the gateway's own `CLAUDE_CONFIG_DIR` at call time | Global today. Not changed by this feature |
| `shared/remote-target.ts:219` | `resolveRemoteClaudeConfigDir`, whose comment says env and trust seed must agree or the first turn hangs | The existing per-employee profile setting |
| `shared/claude-auth.ts:121` | Auth check config-dir seam | Not changed by this feature. On darwin, credentials are in the Keychain and the check fails open |
| `shared/engine-health.ts:54` | `engineHealthForTarget`: health keyed per target | Not changed by this feature. Health is keyed by engine only, so this is not a target key that can simply gain a field |
| `board-walk/route-turn.ts:45` | Employee `cliFlags` come after the gateway's `--chrome`, so `--no-chrome` in `cliFlags` wins | Not changed by this feature. It does not hold on the PTY idle-spawn path (`engines/claude-interactive.ts:3183`) |
| `gateway/org-registry.ts:42` | `refreshOrg`, which keeps the last good roster | Shape for `project-registry.ts` |

### Budgets

| Source | Value |
| --- | --- |
| `mcp/__tests__/tool-manifest-budget.test.ts:11` | `MAX_MANIFEST_TOKENS = 4156` |
| `mcp/__tests__/tool-manifest-budget.test.ts:239` | Measured `pi` wrapper: 4155, one token of headroom |
| `mcp/__tests__/tool-manifest-budget.test.ts:307` | 51 tools pinned |
| Sprint precedent (comments at `:225-237`) | `sprint` on list and edit cost 18 tokens, plus 7 on create, so 25 in all. That is the Q4-b estimate |
| `size-baseline.json:290` | `gateway/api.ts` budget 4803. The file is 4798 |
| `size-baseline.json:514` | `mcp/server.ts` budget 326. The file is 326 |
| `size-baseline.json:587` | `sessions/context.ts` budget 906. The file is **1002**, already over |
| `packages/web/src/lib/api.ts` | At its budget of 876 |
| `node scripts/ratchet.mjs --check` | "102 violations, 14 stale entries" on `main`: the ratchet is red before this feature |

The rule for this feature is that no file at or over budget grows. New behaviour lives in new
modules (`gateway/projects-api.ts`, `gateway/project-scope/*`, `work-items/projects*.ts`,
`sessions/context/project.ts`, `mcp/project-profile.ts`, `lib/project-api.ts`). Any line added
to an over-budget file is paid for in the same PR by moving existing code out.

### Found and rejected

- **The remote-connector principal as the scope carrier.** It is the operator's door, and
  unscoped by design. Projects reuse its *pattern* (a route table at the gate), not its
  principal.
- **Departments as projects.** Departments drive id prefixes and the org tree, and each
  employee has exactly one. Projects cut across departments, and an employee can be in
  several.
- **Labels as projects.** A Todo can carry many labels, and agents create them freely. Scope
  needs at most one per Todo, with administration by the operator only.
- **A `toolset` as the scoped profile.** A toolset replaces the whole tool set
  (`mcp/toolsets.ts:10`). The connector's `profile.ts` filter is the right shape.
- **Filtering inside each list handler.** Several handlers have unfiltered branches (`ids=`,
  `pinned`, `q`) and are over budget. A dedicated read module for scoped callers is where a
  missed branch cannot leak.
- **A session `project_id` on unscoped sessions for badges.** That would make an unscoped
  session match the scoped filter. It was QA's B1 confused deputy: transcript reads, and
  `send_to_session` into an uncontained session. The badge is derived at read time instead
  (FR-009).
- **A stage dir inside `$JINN_HOME`.** Ancestor `CLAUDE.md` loading would pull in the company
  file. Symlinked skills would resolve into the denied tree. A deny on the home would cover
  the stage dir too, because deny wins over allow.

## Containment: what Phase 0 must establish (deferred to the future sandbox work, Q1 = A)

Claude Code 2.1.289 is installed. Its settings support a Bash sandbox, with filesystem and
network rules, and `permissions.deny` rules for the Read and Edit tools.

Phase 0 establishes each item below by running a real session, launched with the gateway's own
argv and its gateway-written `--settings`. Reading documentation does not count. For each item,
record the setting or flag that achieves it, or record that nothing does.

1. **Deny rules under bypass.** With `--dangerously-skip-permissions`, are `permissions.deny`
   rules for Read and Edit under `$JINN_HOME` still enforced? If not, scoped sessions drop
   that flag for a mode that does enforce denies.
2. **No unsandboxed escape.** Can the Bash tool's `dangerouslyDisableSandbox` be closed
   (`sandbox.allowUnsandboxedCommands: false`) while permissions are bypassed? (E5)
3. **Settings precedence.** Do a project-level `.claude/settings.json`, `.mcp.json` or
   `CLAUDE.md` in the cwd override or extend `--settings`? Do write denies on them hold? Can
   hooks added at project level run unsandboxed? (E6)
4. **No browser and no foreign MCP.** Do `--no-chrome` and `--strict-mcp-config` remove the
   Chrome tools, the claude.ai connectors, and user-level MCP servers and plugins? If the
   connectors survive, find the switch that removes them. (E9)
5. **Real work under the sandbox.** Do `git push`, `gh pr create`, `pnpm install`,
   `pnpm build` and headless Playwright work with only the project directories writable and
   the minimal environment plus secret references? Which extra read paths do they need, for
   example `~/.gitconfig`, `~/.ssh`, `~/.config/gh`, the pnpm store, or the Playwright
   browsers?
6. **Ancestor files.** From a stage dir outside `$JINN_HOME`, which ancestor `CLAUDE.md` and
   `AGENTS.md` load? On this host neither `~/CLAUDE.md` nor `~/AGENTS.md` exists.
7. **The jinn MCP server keeps working.** It is a child of `claude` and runs outside the Bash
   sandbox. Does it start from the stage dir with the capability passed on its environment,
   and authenticate through `gateway.json`, while the shell cannot read that file? (E3, E4, E8)
8. **Sub-agents and hooks.** Are Task sub-agents and gateway hooks inside the same sandbox?
   Task sub-agents inherit the parent's identity
   (`mcp/__tests__/tool-manifest-budget.test.ts:205`), so they must inherit its sandbox too.
9. **Reads made outside the sandbox.** With FR-018 in place, do `publish_attachment` and
   `attach_to_work_item` refuse paths under `$JINN_HOME`? (E7)
10. **Process inspection.** Can the sandbox stop `ps -E` and other ways of reading another
    process's environment (`sysctl KERN_PROCARGS2`, `proc_pidinfo`)? (E14) If it cannot,
    every token and capability in a same-user process environment stays readable, and B is
    not buildable without Q11. This is the item most likely to fail.

Two more checks belong to item 8:
- whether hooks run inside the sandbox;
- whether the relay works with its home, URL and credential passed on argv (FR-025a).

Three more checks belong to item 5:
- E11 to E13 (transcripts, sibling projects, credential directories);
- that default-deny reads under `$HOME` still let the toolchain run.

**Exit criterion**: E1 to E15 pass in full on a throwaway gateway with `authRequired: true`.

If any of items 1–4 or 10 cannot be made to hold:
- v1 stays at A;
- the findings are recorded here;
- the operator chooses between C and Q11.

## Issue questions → where they are answered

| Issue question | Answer |
| --- | --- |
| 1. Project vs working directory or repo | Zero or more working directories per project. A project is not a repo (Decided by default) |
| 2. Persona per project | No. Scope is an allow-list, and a different role means a different employee (Assumptions) |
| 3. What belongs to a project in v1 | Todos, with their comments, attachments, events, runs and relations; sessions of scoped employees, through the binding; Notes, in the project folder. Out of v1: cron, workflows (removed upstream), managed files (refused), labels and sprints (company-wide). Spend is capped by the existing per-employee budgets |
| 4. Company-wide vs project skills and knowledge | FR-027 to FR-029, Q5 |
| 5. Concurrent employees in a project | Worktrees, unchanged (Assumptions) |
| 6. Secrets | Deferred with containment (Q1 = A). A friend's account uses the existing per-employee profile setting (spec.md, "Employees on another Claude account") |
| 7. Client layer | No, and nothing is reserved for it (Assumptions) |
| 8. Where config lives and how it is backed up | YAML under `projects/`, mirroring `org/` (operator, Q3). It is carried by the home archive once `projects` is added to `ARCHIVE_INCLUDES` (`backup/archive.ts:9`). Todo membership and session bindings live in the registry, carried by the registry backup (`backup/snapshot.ts:38`) |
