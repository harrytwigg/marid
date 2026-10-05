# Research: Projects and Project-Scoped Employees

Read against `origin/main` at `60e675d6`. Paths are relative to `packages/jinn/src/` unless
they start with `packages/`.

## What already exists (constitution Principle VII)

### Data model

| `path:line` | What it is | Bearing on this feature |
| --- | --- | --- |
| `work-items/sprints-schema.ts:5` | "Additive tables, never columns on `work_items`" | The project dimension is a join table, as sprints are |
| `work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`: tables created at boot when missing | `projects` and `work_item_projects` are registered here |
| `work-items/migrate.ts:536` | `sprints` registered before its membership table | Same ordering for `projects` → `work_item_projects` |
| `work-items/sprints-schema.ts:60` | `sprintFilterCondition`: filters on the **root's** membership (`root_id`) | Same shape for `project=<id>|none`. Sub-tasks inherit their project for free |
| `work-items/sprint-membership.ts:71` | `assertTopLevel`: only roots hold a sprint | Same rule for projects (FR-004) |
| `work-items/store.ts:511` | List filter applies `sprint` | `project` goes next to it |
| `work-items/store.ts:331` | Id prefix comes from the department | Unchanged: the project does not affect numbering |
| `work-items/migrate.ts:161` | `labels.department` nullable = company-wide | Precedent for a nullable scope column on a registry row |
| `sessions/migrate.ts:342` | Sessions use add-column-if-missing | `sessions.project_id` is a plain added column, with no exact-shape verifier to satisfy |
| `sessions/migrate.ts:117` | `files` table: no session or owner column | Managed files cannot be scoped, so FR-016 refuses them for scoped callers |
| `shared/types.ts:515` | `Employee` | Gains `projects?: string[]` |
| `shared/types.ts:529` | `mcp` allow-list, the only per-employee allow-list today | Precedent for an optional list field on the employee |
| `gateway/org.ts:78` | YAML → `Employee` field mapping | Reads `projects` |
| `gateway/org.ts:170` | `WRITABLE_FIELDS` for `PATCH /api/org/employees/:name` | Gains `projects` |

### Enforcement points

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `mcp/identity.ts:143` | `deriveSessionCapability`: HMAC of the session id under `secrets/mcp-session-capability.key` | The scoped caller is identified exactly as today |
| `mcp/identity.ts:162` | `verifySessionCapability` | Unchanged |
| `mcp/identity.ts:42` | "defense-in-depth … not an internet auth boundary" | Why Q1 exists |
| `mcp/server-bootstrap.ts:25` | The MCP server **derives** the capability itself from the key file, given only a session id and the home path on argv | Any process that can read the key can mint any session's capability. FR-023 |
| `gateway/session-comm-guards.ts:333` | `resolveCallerIdentity`: operator, session, unidentified-tool or unauthenticated | The scope check reads the session from here |
| `gateway/api.ts:603` | `resolveScopedWriteCallerIdentity` | Same |
| `gateway/api.ts:1181` | `refuseRemoteMcpRoute` at the identified-caller gate | **The exact precedent:** a per-principal route allow-list enforced in one place. The scoped-caller gate goes next to it |
| `gateway/remote-mcp/rules.ts:25` | `ALLOWED_ROUTES` table for the connector | Shape to copy, as `gateway/project-scope/rules.ts` |
| `gateway/api.ts:1212` | `operatorOnlyControlPlaneRoute` | Already refuses config, cron and org writes for any non-operator |
| `gateway/control-plane-routes.ts:12` | The operator-only route table | Same |
| `gateway/api.ts:841` | `rejectUnverifiedIdentifiedApiCaller` lets unauthenticated `GET`s through when auth is off | Q6 and FR-024 |
| `gateway/auth.ts:264` | `shouldRequireGatewayAuth`: off on loopback unless `gateway.authRequired` | Same |
| `gateway/api.ts:530` | `resolveWorkItemCaller` | Per-Todo scope check |
| `gateway/work-item-authority.ts:25` | `hasStandingOverWorkItem`: org root, owner, or manager above the owner | Scope is checked **before** standing. Standing is never widened |
| `gateway/work-item-standing.ts:20` | `mayRetagTodo` | Who may change a Todo's project (the same people who may change its sprint) |
| `gateway/api.ts:2147` / `:2171` | `GET /api/work-items` → unscoped `queryWorkItems` | The project filter is forced for scoped callers |
| `gateway/api.ts:1743` | `GET /api/sessions`, unscoped | Filtered by `project_id` for scoped callers |
| `gateway/api.ts:3273` | `POST /api/delegations` | FR-015 target check |
| `gateway/api.ts:3640` | `POST /api/sessions` (spawn) | FR-015 and FR-008 binding |
| `gateway/spawn-session.ts:163` | `spawnSession`: every spawn path converges here | The binding is set here, once |
| `gateway/api.ts:3695` | `POST /api/sessions/:id/message` | FR-012 target check |
| `gateway/api.ts:905` | `resolveSpawnParentSessionId` accepts any existing session as parent | Scoped callers may only name a P-bound parent |
| `gateway/todo-dispatch.ts:197` | `startTodoDispatcher` (dispatch, board walk) | FR-015 assignee check |
| `gateway/api.ts:1681` / `:1694` | Knowledge search and read routes | Rooted per FR-027 |
| `notes/store.ts:613` | `SEARCH_ROOTS = ["knowledge", "docs"]` | Becomes a parameter. Scoped callers pass their project roots |
| `notes/store.ts:729` | `readKnowledgeFile`: containment in the home only, **no `secrets/` exclusion** | Q6 |
| `shared/file-read-policy.ts:58` | "Refusing to read Jinn secrets", used only by `/api/files/read` and attachments | Q6-a extends it to `read_knowledge` |
| `shared/protected-home-entries.ts:41` | Protected entries: `secrets`, `gateway.json`, `config.yaml`, `tmp/mcp`, … | Same list, and the containment deny list starts from it |
| `mcp/file-tools.ts:96` | `publish_attachment` path: any absolute path, regular file, ≤ 50 MB | FR-016 and Q6 |
| `mcp/server.ts:112` | `buildTools` | A scoped session gets a filtered profile (below) |
| `gateway/remote-mcp/profile.ts:98` | The connector's tool filter | Precedent for a filtered tool profile per principal |

### Engine spawning

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `sessions/turn/engine-run.ts:46` | Local engines always run with `cwd: JINN_HOME` | FR-020: scoped sessions get the stage dir |
| `gateway/server.ts:504` | Exports `JINN_GATEWAY_TOKEN` into `process.env` for every engine | FR-021 |
| `shared/child-env.ts:41` | `buildEngineChildEnv`: inherits `process.env` minus a short deny list | FR-021 needs an allow-list builder for scoped sessions |
| `engines/claude-interactive.ts:451` | Claude argv: `--chrome`, `--dangerously-skip-permissions`, … | Phase 0 confirms the sandbox and deny rules still apply under this flag |
| `shared/claude-settings.ts:70` | `buildSessionSettings`: hooks and status line only | The sandbox and `permissions.deny` blocks go here for scoped sessions |
| `board-walk/route-turn.ts:48` | `CLAUDE_WALK_FLAGS`: `--no-chrome --tools "" --strict-mcp-config` | The only existing locked-down Claude turn |
| `gateway/watcher.ts:38` | `syncSkillSymlinks`: every skill → `~/.jinn/.claude/skills` | The stage dir gets its own filtered link set |
| `work-items/dispatch-config.ts:253` | `resolveTodoDispatch`: skills are added as prompt lines | FR-026 validates against the allow-list |
| `sessions/context.ts:198` | `buildContext` | Scoped sessions get a project section and a scoped roster |
| `sessions/context.ts:298` | Working roster | Filtered to project members |
| `sessions/context.ts:345` | Knowledge section | Points at the project Notes root |
| `sessions/turn/preflight.ts:52` | `refuseTurn`: the single gate before any engine spawn | Refuses a turn whose binding the employee has lost, or a scoped employee on a non-claude engine |
| `mcp/resolver.ts:51` | Per-employee MCP server selection | Unchanged |

### Budgets

| Source | Value |
| --- | --- |
| `mcp/__tests__/tool-manifest-budget.test.ts:11` | `MAX_MANIFEST_TOKENS = 4156` |
| `mcp/__tests__/tool-manifest-budget.test.ts:239` | Measured `pi` wrapper: 4155. One token of headroom |
| `mcp/__tests__/tool-manifest-budget.test.ts:307` | 51 tools pinned |
| `size-baseline.json:290` | `gateway/api.ts` budget 4803 lines; the file is 4798. Only 5 lines of room |
| `size-baseline.json:514` | `mcp/server.ts` budget 326 lines; the file is 326 |
| `size-baseline.json:587` | `sessions/context.ts` budget 906 lines |
| `packages/web/src/lib/api.ts` | At its recorded budget (876). New web calls go in `lib/project-api.ts`, as `lib/sprint-api.ts` did |

Consequence: every new gateway behaviour lives in new modules (`gateway/projects-api.ts`,
`gateway/project-scope/*`, `work-items/projects*.ts`). `api.ts` gains only the mount line and
the gate call, at most 5 lines.

### Found and rejected

- **The remote-connector principal as the scope carrier.** It is the operator's door, by
  design unscoped (`specs/004-remote-mcp-connector/spec.md` amendment). Projects reuse its
  *pattern* (a route table at the gate), not its principal.
- **Departments as projects.** Departments drive id prefixes and the org tree, and are
  per-employee singular. Projects cut across departments, and an employee can be in several.
  Overloading departments would change Todo numbering, which the issue rules out.
- **Labels as projects.** Labels are many-per-Todo and self-service. Scope needs at most one
  per Todo and operator-only administration.
- **`toolset` / board-walk toolset as the scoped profile.** `toolset` replaces the whole tool
  set (`mcp/toolsets.ts:10`). Scoped sessions need the normal set minus refused groups, which
  is the connector's `profile.ts` filter shape, not a toolset.

## Containment: what Phase 0 must establish

Claude Code 2.1.289 is installed. Its settings support a Bash sandbox (filesystem and network
rules) and `permissions.deny` rules for the Read and Edit tools. Phase 0 must establish each of
these by running a real session, not by reading documentation:

1. With `--dangerously-skip-permissions`, are `permissions.deny` rules for `Read(~/.jinn/**)`
   and `Edit(~/.jinn/**)` still enforced? If not, the stage-dir session must drop that flag and
   run in a permission mode that still enforces deny rules.
2. Does the Bash sandbox deny reads under `$JINN_HOME` while allowing a stage dir *inside* it
   (allow-subpath after deny-path)? If not, the stage dir moves outside `$JINN_HOME`.
3. Can the Bash sandbox block loopback connections to the gateway port while the MCP server,
   which runs outside the Bash sandbox, still reaches it? If yes, FR-024 needs no gateway
   auth change and Q6's approval is moot. If no, gateway auth goes on.
4. Does the jinn MCP server, a child of `claude` outside the Bash sandbox, start correctly from
   a stage-dir cwd when the capability is passed on its environment instead of derived
   (FR-023)?
5. Do `git push`, `gh pr create`, `pnpm install` and `pnpm build` work under the sandbox with
   the project working directories writable and only the minimal environment plus secret
   references? What extra read paths do they need (`~/.gitconfig`, `~/.ssh`, `~/.config/gh`,
   pnpm store)?
6. Are sub-agents (the Task tool) and hooks covered by the same sandbox? Claude Task
   sub-agents inherit the parent's identity (`mcp/__tests__/tool-manifest-budget.test.ts:205`),
   which is fine provided they inherit its sandbox too.

The exit criterion is the US3 escape script passing in full on a throwaway gateway. If
item 1 or 2 cannot be made to hold, Q1 falls back to A for v1, and the spec's US3 is moved to
a follow-up with the findings recorded.

## Issue questions → where they are answered

| Issue question | Answer |
| --- | --- |
| 1. Project vs working directory or repo | Zero or more working directories per project, not a repo (Decided by default) |
| 2. Persona per project | No. Scope is an allow-list, and a different role means a different employee (Assumptions) |
| 3. What belongs to a project in v1 | Todos, plus their comments, attachments, events, runs and relations via the Todo; sessions (binding); spend (derived from bound sessions); Notes (project folder). Out of v1: cron, workflows (removed upstream), managed files (refused), labels and sprints (company-wide) |
| 4. Company-wide vs project skills and knowledge | FR-026 to FR-028, Q5 |
| 5. Concurrent employees in a project | Worktrees, unchanged (Assumptions) |
| 6. Secrets | FR-030, FR-031, Q7 |
| 7. Client layer | No, and nothing reserved for it (Assumptions) |
| 8. Where config lives and how it backs up | Q3. DB is recommended, carried by the registry backup (`backup/snapshot.ts:38`); employee scope is in org YAML, carried by the home archive (`backup/archive.ts:9`) |
