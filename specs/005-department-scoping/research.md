# Research: Department-Scoped Employees and Per-Employee Claude Profiles

Read against `origin/main` at `60e675d6`, and re-verified at `3c032251` for every row spec.md
and plan.md cite. The "Departments today", "Claude profiles" and "Remote targets" sections
were read at `3c032251`. Paths are relative to `packages/jinn/src/` unless
they start with `packages/`.

**After the operator's decisions (2026-10-05):**

- Q1 = A: no sandbox in this feature.
- Q6 = b: existing employees read as today.

**After the operator's decisions (2026-10-06):**

- D1: the department is the unit of scope. The project registry is dropped.
- D2: local employees can name their own Claude profile.

So the "Local file reads" rows and the "Containment" section below stay as findings, but
nothing in this feature acts on them. They apply only to scoped callers (FR-018, FR-028), or
they belong to the future sandbox work. Phase S, Phase 0 and the old containment Phase 4 are
withdrawn.

## What already exists (constitution Principle VII)

### Data model

| `path:line` | What it is | Bearing on this feature |
| --- | --- | --- |
| `work-items/migrate.ts:520` | `V2_ADDITIVE_TABLES`: tables created at boot when missing | `department_scopes` is registered here |
| `work-items/migrate.ts:294` | The `departments` table: slug, a fixed three-letter prefix, created time | Unchanged. Scope is not a column here, because the boot verifier checks table shapes exactly |
| `work-items/store.ts:331` | The id prefix comes from the department | A scoped department gets its own numbering for free |
| `work-items/store.ts:474` | `department` is a plain equality filter on the list | A department board is not access control. Scoped reads go through the read module |
| `work-items/migrate.ts:161` | `labels.department` is nullable, and null means company-wide | Stored only, never enforced. Labels stay company-wide |
| `sessions/migrate.ts:342` | Sessions use add-column-if-missing | `sessions.scope_department` is a plain added column. The FR-013 requester reuses `parent_session_id` (`sessions/migrate.ts:26`) |
| `sessions/migrate.ts:117` | The `files` table has no session or owner column | Managed files cannot be scoped, so FR-018 refuses them for scoped callers |
| `shared/types.ts:515` | `Employee` | Gains `claudeConfigDir` (FR-050). Scope needs no field |
| `shared/types.ts:520` | `department: string` | One department per employee, so one scope per employee |
| `shared/types.ts:529` | `mcp` allow-list, the only per-employee allow-list today | Precedent for an optional field on the employee |
| `gateway/org.ts:170` | `WRITABLE_FIELDS` for `PATCH /api/org/employees/:name` | Already has `department`. `claudeConfigDir` stays YAML-only, like the remote fields |
| `gateway/api.ts:2187` | Create refuses `assignee` | There is no create-with-assignee path |
| `gateway/api.ts:2192` | `parentId` is accepted only at create | There is no re-parent path |

### Departments today

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `gateway/org.ts:31` | The org walker skips `department.yaml` | Nothing reads the file today. The department registry reads it (FR-001) |
| `shared/types.ts:594` | A `Department {name, displayName, description}` type, re-exported but unused | The definition type extends it |
| `gateway/org.ts:81` | An employee's department is the YAML field, else the directory name | The two can disagree. FR-007 refuses a mismatch that touches a non-open department |
| `gateway/org-api.ts:25` | `GET /api/org` lists departments as directory names | Three lists can diverge: directories, employee fields and registry slugs. Scope is read only from `department.yaml` in a directory |
| `work-items/departments.ts:40` | `resolveDepartmentPrefix` registers a slug lazily on first use | Any writer can mint an open department in open mode. Scope cannot be minted that way (FR-005) |
| `shared/todo-departments-config.ts:14` | `gateway.todoDepartments`: open when unset (this instance), closed when set | Both modes keep working. FR-003 only changes behaviour for non-open departments |
| `work-items/assignment.ts:72` | Open mode moves a Todo to the assignee's department on assignment | The leak FR-003 closes: assigning a scoped Todo to an Engineering employee would move it to Engineering |
| `gateway/api.ts:2650` | The assign route passes `employee?.department ?? null` | `@operator` and engine-only delegates null the department in open mode |
| `gateway/api.ts:3461` / `:3501` | Delegation passes the delegate's department in open mode | Also kept for non-open departments |
| `work-items/store.ts:324` | Create takes the named department, else the parent's, else the policy default | A sub-task can name a different department today. FR-004 refuses that across a non-open boundary |
| `gateway/api.ts:2466` | The department field is operator-only in the metadata pen | Scoped callers cannot move a Todo out, and nor can agents |
| `gateway/api.ts:3196` | "there are no create/rename routes" for departments | Rename stays unsupported |
| `gateway/work-item-authority.ts:25` | Standing over a Todo comes from the reporting tree | Departments carry no authority today. Scope adds a boundary, not authority |
| `gateway/org-hierarchy.ts:82` | The manager is `reportsTo`, else inferred within the department | A scoped department's members can report to anyone. Authority does not cross the scope, because scoped reads hide everything outside D |
| `gateway/system-employees.ts:22` | Dispatcher and Shaper are in `system` | `system` cannot be scoped (FR-006) |
| `packages/web/src/routes/todos/board/board-route.ts:6` | Boards are `attention`, `everything` or a department slug | The switcher rows gain the scope badge |
| `packages/web/src/components/org/layout/d3-tree-layout.ts:125` | The org map draws one group box per department | The group box gains the scope badge |

### Claude profiles

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `shared/home.ts:34` / `:42` | `resolveClaudeConfigDir` and `claudeJsonPath` read the gateway's own environment | Gain a profile argument |
| `shared/child-env.ts:41` | `buildEngineChildEnv` passes the gateway's `CLAUDE_CONFIG_DIR` through | The named profile is set here |
| `engines/claude-interactive.ts:3146` / `:3255` / `:2152` | Local turn spawn, idle spawn and redelivery respawn | FR-051 |
| `sessions/turn/engine-run.ts:41`, `sessions/turn/rate-limit-turn.ts:157`, `sessions/rate-limit-handler.ts:104`, `gateway/pty-ws.ts:125`, `sessions/turn/auto-compact.ts:168` | Where run options are built | Each passes the profile |
| `sessions/fork.ts:72` / `:129` | Headless and interactive fork environments, built from `process.env` | FR-051 |
| `engines/claude-interactive.ts:276` | `findTranscriptForSession`, defaulting to the global projects dir. Used at `:2117`, `:2648`, `:2726`, `:2740` | FR-053 |
| `gateway/external-turns.ts:231`, `:390`, `:522` | External turn transcript reads | FR-053 |
| `gateway/api.ts:4634` / `:4748` | `loadRawTranscript` and `loadTranscriptMessages`, called at `:3248` (the transcript route) and `:4722` (backfill) | FR-053 |
| `sessions/fork.ts:171` | `claudeProjectDir` | FR-053 |
| `gateway/server.ts:563` | The boot trust seed, default profile only | FR-052 adds a lazy seed per profile |
| `shared/claude-settings.ts:149` | Bypass-permissions consent is deliberately not seeded on the host | The operator's profile avoids the dialog only through `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`. FR-052a carries it |
| `shared/claude-settings.ts:70` | `buildSessionSettings`: the per-session `--settings` holds only the hook relay and the status line | The operator's `attribution`, `hooks.PreToolUse` (the Slack guard on this instance) and bypass consent live in `~/.claude/settings.json`, which a named profile does not read. FR-052a |
| `shared/child-env.ts:55` | The child environment copies `process.env` | An inherited `CLAUDE_SECURESTORAGE_CONFIG_DIR` would override the Keychain name. FR-051 removes it for named profiles |
| `shared/claude-auth.ts:134` | `readClaudeCredentialStatus` takes a `configDir`, but every caller omits it. On darwin a missing file reads as `unknown` (`:147`) | FR-054 uses the Keychain by name instead |
| `sessions/claude-auth-watch.ts:51`, `shared/claude-auth-outage.ts:18` | One outage scope, `local`, for every local employee | FR-055 |
| `shared/claude-models.ts:262` / `:304` | Reads the Keychain entry `Claude Code-credentials` by fixed name, then the default credentials file | Stays on the default profile (FR-057) |
| `shared/engine-limits-claude.ts:111`, `connectors/telegram/auth-providers.ts:60` | `claude auth status` for the plan, and the Telegram auth providers | Stay on the default profile (FR-057) |
| `shared/engine-health.ts:54` / `:127` | Health is keyed by engine, optionally host | FR-055 adds a profile key |
| `sessions/turn/settle.ts:124`, `sessions/rate-limit-handler.ts:118` / `:322` | Health writers with no host | Account-wide today |
| `board-walk/route-turn.ts:85`, `board-walk/snapshot.ts:238`, `sessions/new-session-engine.ts:60` | Health readers | Read the profile's key |
| `shared/usageAwareness.ts:10` | One rate-limit memory file | FR-055 |
| `shared/engine-limits-claude.ts:233` | `collectClaudeLimits`: one token, the newest snapshot in one `CLAUDE_LIMITS_DIR` | Snapshots are filtered per profile. The OAuth usage reading stays on the default profile |
| `board-walk/snapshot.ts:224` | The board walk reads the five-hour window (`claudeFiveHour`) | Reads the profile it is about to start |
| `shared/file-read-policy.ts:64` | Refuses `auth*` files under the default config dir or any `.claude` segment | A profile elsewhere is not covered. FR-050 adds every `claudeConfigDir` |

**The Keychain**, checked in the installed Claude Code 2.1.291: the service name is
`Claude Code` + `-credentials` + a suffix. The suffix is empty when `CLAUDE_CONFIG_DIR` is
unset, and `-` plus the first 8 hex characters of sha256 of the config dir string when it is
set. The string is the raw `CLAUDE_CONFIG_DIR` value, NFC-normalised, with no realpath and no
trailing-slash stripping. A defined `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides both the input
and the decision. This reading was matched by content in minified code, so Phase 4 confirms it. This Mac has one entry,
`Claude Code-credentials`. Phase 4's first task confirms the suffix with a throwaway profile.

### Remote targets

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `shared/types.ts:182` | `remoteClaudeConfigDir` | The pattern for `claudeConfigDir` |
| `shared/remote-target.ts:114` / `:230` | Its validation and its precedence over `remote.claudeConfigDir` | Copied for the local field |
| `engines/remote-stage.ts:658` | `verifyClaudeProfile`, which caches only successes (`:639`) | Copied for the local check |
| `sessions/turn/engine-run.ts:55` | Passes host, user and cwd, but not the profile | A bug: ordinary remote turns and auto-compaction fall back to the instance default. FR-058 |
| `sessions/rate-limit-handler.ts:104` | Rebuilds the remote target from the employee, profile included | The rate-limit path keeps the profile. `rate-limit-turn.ts:166`'s omission is redundant |
| `shared/config-types.ts:268` / `:274` | `remoteCwd` must sit under `remote.root`, and the remote `$JINN_HOME` is a link farm over the gateway's real knowledge, docs, org and skills | A scoped remote session gets a home with no farm links, and a stage dir under `remote.root` (FR-060, FR-062) |
| `engines/remote-stage.ts:966` | `FARM_SCRIPT`: links every top-level entry of the mount into the session home, and links the company `CLAUDE.md` into `remoteCwd` when it is not a git tree | Left untouched. Scoped sessions run a scoped variant (FR-062) |
| `engines/remote-stage.ts:792` / `:167` | `serializePerHost`, and `stageRemoteFile` (temp file, then rename) | The stage-dir push runs inside the first and follows the second's discipline (FR-060) |
| `engines/remote-stage.ts:1248` | `prepareRemoteSession`: farm, assets and trust seed under the per-host lock, then the session's own files | Gains an optional department (Phase 5) |
| `mcp/file-tools.ts:98`, `mcp/work-item-attachments.ts:103` | `publish_attachment` and path-based `attach_to_work_item` read the file in the jinn MCP server and upload the bytes; neither uses the JSON `{path}` route. For a remote session that server runs on the remote host (its config is remapped to the remote install, `engines/remote-stage.ts:1398`) | FR-018 and FR-065 check the path limit in both tools |
| `shared/remote-target.ts:207` | `employeeRemoteTarget`, called by `pty-ws.ts:134`, `turn/remote-ready.ts:76`, `session-file-read.ts:67` and `cli/remote.ts:58`; `engine-run.ts:55` builds its target inline | FR-061 puts the scoped cwd override in this one helper |
| `shared/remote-target.ts:156` | `remote.root` and `remote.mount` are each checked to be absolute; nothing stops the mount sitting under the root | FR-061 refuses a scoped `remoteCwd` over the mount |
| `engines/remote-stage.ts:418`, `:912`, `:936` | The per-host stage root holds every session's `gateway.json`; the trust key includes the cwd; the trust seed runs `mkdir -p <cwd>` | FR-061 spawn-time check; FR-020a keeps the cwd stable; the sync runs before the seed |
| `sessions/fork.ts` | No remote target is built | Fork has no remote path, so FR-061 does not list it |

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
| `gateway/remote-mcp/rules.ts:25` | `ALLOWED_ROUTES`, the connector's allow-list | Shape copied for `gateway/department-scope/rules.ts` |
| `gateway/api.ts:1212` | `operatorOnlyControlPlaneRoute` | Already refuses config, cron and org writes to every non-operator |
| `gateway/control-plane-routes.ts:12` | The operator-only route table | Same |
| `gateway/upgrade-guards.ts` (imported at `gateway/server.ts:62`) | WebSocket upgrade guards | Scoped callers are refused here. Upgrades never reach `handleApiRequest` |
| `gateway/api.ts:530` | `resolveWorkItemCaller` | The per-Todo check |
| `gateway/work-item-authority.ts:25` | `hasStandingOverWorkItem`: the org root, the owner, or a manager above the owner | Scope is checked **before** standing. Standing is never widened |
| `gateway/work-item-standing.ts:20` | `mayRetagTodo` | Who may retag a Todo. A department change is already operator-only (`gateway/api.ts:2466`) |
| `gateway/api.ts:2148` | `GET /api/work-items?ids=` returns the Todos it names, unfiltered | The scoped read module covers this branch |
| `gateway/api.ts:2171` | The query form calls `queryWorkItems` | Same |
| `gateway/api.ts:1744` | `GET /api/sessions` has `pinned` and `q` branches | Same |
| `gateway/api.ts:3273` | `POST /api/delegations` | FR-016 target check |
| `gateway/api.ts:3640` | `POST /api/sessions` (spawn) | FR-016, and the FR-008 binding |
| `gateway/spawn-session.ts:163` | `spawnSession`, where every spawn path converges | Sets the binding, once. `parentSessionId` (`:188`) is the requester |
| `gateway/api.ts:3695` | `POST /api/sessions/:id/message` | FR-012 and FR-013 |
| `gateway/api.ts:905` | `resolveSpawnParentSessionId` accepts any existing session as parent | Scoped callers may name only a parent bound to D |
| `work-items/assignment.ts:77` | `assignWorkItem`. Callers: `gateway/api.ts:2650` (assign), `gateway/api.ts:3501` (delegation), `talk/control/todo-adapters.ts:132`, `talk/control/delegation-adapter.ts:107` | Covered by the store-level check |
| `gateway/api.ts:2409` | PATCH sets `assignee` directly, without `assignWorkItem` | Covered by the store-level check |
| `gateway/api.ts:3450` | Delegation with no existing Todo creates one already assigned | Covered by the store-level check |
| `plugins/host/todos.ts:31` | A plugin create passes `draft.assignee` and `parentId` | Covered by the store-level check |
| `work-items/store.ts:356`, `:797`, `:850` | Every writer of `assignee` (`:961` says so) | **Where `mayHoldTodo` lives** |
| `gateway/todo-assignee.ts:21` | `checkAssignee` accepts `@operator` | `mayHoldTodo` admits `@operator` |
| `gateway/todo-dispatch.ts:197` | `startTodoDispatcher` (dispatch and board walk) | Routing check |
| `gateway/self-compaction-api.ts:217` | `POST /api/compactions` | Own session only |
| `gateway/todo-capture-api.ts:172` | `capture-landing` (`land_on_work_item`) | Todo must be in D |
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
| `mcp/work-item-attachments.ts:68` | Path-based `attach_to_work_item`, through `readLocalFileForIngestion` | The policy does not protect `registry.db`, `org/`, `CLAUDE.md`, or other departments' directories. FR-018 |
| `gateway/api.ts:2925` | JSON `{path}` attachment ingestion, read inside the gateway | Same |

### Engine spawning

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `sessions/turn/engine-run.ts:46` | Local engines always run with `cwd: JINN_HOME` | FR-020: scoped sessions get the stage dir |
| `gateway/server.ts:504` | Exports `JINN_GATEWAY_TOKEN` to every engine | Deferred to the sandbox work |
| `shared/child-env.ts:41` | `buildEngineChildEnv` passes on `process.env` minus a short deny list | Built for local scoped sessions (`scopedSession`, `isScopedSessionEnvName`), keeping `JINN_GATEWAY_TOKEN`; the allow-list without it is deferred to the sandbox work. It stops inheritance only: as the gateway's user the session can still read `/proc/<gateway pid>/environ` |
| `engines/claude-interactive.ts:451` | Claude argv: `--chrome` (`:451`, the operator's own browser), `--dangerously-skip-permissions` (`:454`), the gateway-written `--settings` under `tmp/` (`:456`), and `--mcp-config` without `--strict-mcp-config` (`:459`) | Deferred to the sandbox work |
| `shared/claude-settings.ts:70` | `buildSessionSettings` writes hooks and a status line only | Deferred, not built: sandbox and deny blocks |
| `board-walk/route-turn.ts:48` | `CLAUDE_WALK_FLAGS`: `--no-chrome --tools "" --strict-mcp-config` | The only existing locked-down Claude turn |
| `gateway/watcher.ts:38` | `syncSkillSymlinks` links every skill into `~/.jinn/.claude/skills` | The stage dir gets copies of the allowed skills instead |
| `work-items/dispatch-config.ts:253` | `resolveTodoDispatch` adds skills as prompt lines | FR-027 validates them against the allow-list |
| `sessions/context.ts:198` | `buildContext` | The department section comes from a new module |
| `sessions/context.ts:298` | Working roster | Filtered to members |
| `sessions/context.ts:345` | Knowledge section | Points at the department Notes root |
| `sessions/turn/preflight.ts:52` | `refuseTurn`, the gate before every engine spawn | Lost binding, wrong engine, profile not signed in |
| `sessions/turn/preflight.ts:63` | Per-employee monthly budget check | Already a per-scope cap, since a scoped employee works only in its department |
| `sessions/fork.ts:164` / `engines/claude-interactive.ts:271` | Transcripts are keyed by the cwd slug | Resume, fork and compaction must resolve the stage-dir slug |
| `shared/claude-settings.ts:124` | Trust entries per directory in `~/.claude.json` | The only seed today is boot-time (`gateway/server.ts:565`). Phase 3 adds one per stage dir |
| `board-walk/route-turn.ts:45` | Employee `cliFlags` come after the gateway's `--chrome`, so `--no-chrome` in `cliFlags` wins | Unchanged. It does not hold on the PTY idle-spawn path (`engines/claude-interactive.ts:3183`) |
| `gateway/org-registry.ts:42` | `refreshOrg`, which keeps the last good roster | Shape for `department-registry.ts` |

### Limits and the board walk (Phase 6)

Read at `origin/main` 70419b04.

| `path:line` | What it is | Bearing |
| --- | --- | --- |
| `packages/web/src/routes/limits/page.tsx:232` | One `EngineCard` per engine, in a two-column grid | FR-073: one card per account, grouped by engine |
| `packages/web/src/routes/auto-dispatch/usage-card.tsx:57` | "Where the Claude allowance is heading": one Claude history | FR-074 |
| `shared/engine-limits.ts:323` | `collectEngineLimits` loops over engines, one slot each | Loops over accounts |
| `shared/engine-limits-claude.ts:233` | `collectClaudeLimits`: OAuth usage API, then the newest status-line snapshot, plus `claude auth status` for the plan | Takes an account (FR-071) |
| `shared/claude-models.ts:289` | `readClaudeOAuthToken`: env, then the unsuffixed Keychain entry, then the default credentials file | Gains an account argument; the model catalog keeps the default |
| `shared/engine-reset-times.ts:55` | One Claude reset time for the backoff | Per account |
| `shared/claude-usage-history.ts:44` | One usage-history file | Per account |
| `shared/usageAwareness.ts:10` | One rate-limit record, read only by a preflight notice | Per account (FR-055) |
| `shared/engine-health-store.ts:45` | One health record per engine; quota records carry no host | Per account (FR-055) |
| `engines/remote-stage.ts:1378` | Remote sessions write no status-line snapshot to the gateway | The gateway reads remote accounts itself over SSH (FR-072) |
| `board-walk/snapshot.ts:14`, `:224`, `:238` | No numeric thresholds in code; one Claude five-hour window; an unscoped exhausted flag | Per-account snapshot (FR-075) |
| `packages/jinn/template/board-walk.md:98` | The thresholds, "hold, never guess", concurrency and "one start per tick" are prose about one Claude pool | Rewritten per account; the instance copy is the operator's (FR-077) |
| `board-walk/apply.ts:245` | `startTodo` checks only the switch, the status and the opt-out | Gains the exhausted-account gate (FR-075) |
| `board-walk/walk.ts:142` | `dispatcherSuffix` passes a preferred engine to the Dispatcher as advice | Also lists exhausted accounts |
| `board-walk/route-turn.ts:85` | The walk skips the tick when its runner engine is exhausted | FR-076 |
| `gateway/todo-dispatch.ts:147` | The Dispatcher starts with no limits check | Unchanged; the walk gates before it |
| `shared/claude-models.ts:244`, `:290` | An expired access token reads as no token, and the gateway never refreshes one; `$CLAUDE_CODE_OAUTH_TOKEN` is checked first | An idle account has no live reading (FR-075a); a named account's read skips the variable (FR-071) |
| `shared/engine-limits-claude.ts:163` | A status-line snapshot is stale after 30 minutes | Same |
| `shared/engine-limits-claude.ts:239`, `shared/engine-reset-times.ts:37` | The newest snapshot in the shared directory, whoever wrote it | From Phase 4, readers take only default-account snapshots (FR-055) |
| `shared/engine-fallback.ts:24`, `:178`; `shared/config-types.ts:94` | `engines.<engine>.fallback` chains: validated (unknown names and self-references refused, cycles tolerated) and walked with health | FR-079 extends the entries to accounts. This instance's `config.yaml` sets no chain today |
| `sessions/rate-limit-handler.ts:121`, `:138` | Branch A hands a rate-limited turn to the chain, as a fresh session with recent history; a board-walk turn is never substituted | Account substitutes reuse Branch A; FR-076 keeps the walk rule |
| `engines/remote-stage.ts:562`, `:665` | `probeReachable`; the remote sign-in check looks for `<profile>/.credentials.json` over SSH | FR-072 reads the token from the same file, only when the host is reachable |
| `sessions/claude-auth-watch.ts:50` | `claudeAuthScope`: `local`, or `<user>@<host>[:<remoteClaudeConfigDir>]` | Remote account keys include the user; the ledger keeps these strings (FR-070) |

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
modules (`gateway/department-registry.ts`, `gateway/departments-api.ts`,
`gateway/department-scope/*`, `sessions/context/department-scope.ts`,
`mcp/department-profile.ts`, `shared/claude-profile.ts`, `lib/department-api.ts`). Any line added
to an over-budget file is paid for in the same PR by moving existing code out.

### Found and rejected

- **The remote-connector principal as the scope carrier.** It is the operator's door, and
  unscoped by design. Scoping reuses its *pattern* (a route table at the gate), not its
  principal.
- **A separate project concept beside departments** (the first draft of this spec). It would
  allow an employee in several scopes, and grouping a department's work by client without
  changing its numbering. Neither is a requirement, and a department already gives the
  board, the prefix and the org tree group. Two overlapping scopes would double the rules on
  every scoped route. The operator chose departments (D1). Grouping by client, if it is ever
  needed, can use labels or sprints.
- **Labels as scopes.** A Todo can carry many labels, and agents create them freely. Scope
  needs at most one per Todo, with administration by the operator only.
- **A `toolset` as the scoped profile.** A toolset replaces the whole tool set
  (`mcp/toolsets.ts:10`). The connector's `profile.ts` filter is the right shape.
- **Filtering inside each list handler.** Several handlers have unfiltered branches (`ids=`,
  `pinned`, `q`) and are over budget. A dedicated read module for scoped callers is where a
  missed branch cannot leak.
- **A session binding on unscoped sessions for badges.** That would make an unscoped
  session match the scoped filter. It was QA's B1 confused deputy: transcript reads, and
  `send_to_session` into an uncontained session. The badge is derived at read time instead
  (FR-009).
- **Only setting `CLAUDE_CONFIG_DIR` for a named profile.** Transcripts, trust, the signed-in
  check, the outage ledger, engine health and the limits would all keep reading the default
  account, so one account's limit would stop the other and resume would not find
  transcripts.
- **Refusing scoped employees on remote targets** (the draft before D5). The operator wants
  the system to work off this Mac (D5), so Phase 5 stages scoped remote sessions instead.
- **Replacing the stage dir by a directory rename.** `rename(2)` onto a non-empty directory
  fails, `mv` nests the new directory inside the old one, and a two-step swap deletes running
  sessions' cwd. FR-020a syncs in place instead.
- **A cache of the pushed content hash.** It outlives a wiped or edited remote stage dir. The
  sync runs before every scoped spawn instead.
- **Linking the remote stage dir through the sshfs mount** instead of syncing a copy. The
  session's cwd would sit on a network filesystem, and every scoped remote session would stop
  when the mount drops. A pushed copy needs the mount only for what the unscoped path already
  uses.
- **A profile owner marker** (`claudeProfileOwner`, the FR-059 option (b) in an earlier
  draft). The operator owns every profile, and the system does not track ownership (D4).
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
| 1. Project vs working directory or repo | A scoped department has zero or more working directories. It is not a repo (Decided by default) |
| 2. Persona per scope | No. Scope is an allow-list, and a different role means a different employee (Assumptions) |
| 3. What belongs to a scope in v1 | Todos in the department, with their comments, attachments, events, runs and relations; sessions of scoped employees, through the binding; Notes, in the department folder. Out of v1: cron, workflows (removed upstream), managed files (refused), labels and sprints (company-wide). Spend is capped by the existing per-employee budgets |
| 4. Company-wide vs scoped skills and knowledge | FR-027 to FR-029, Q5 |
| 5. Concurrent employees in a scope | Worktrees, unchanged (Assumptions) |
| 6. Secrets | Deferred with containment (Q1 = A). A friend's account is a per-employee Claude profile (FR-050 to FR-059), signed in once by the operator |
| 7. Client layer | No, and nothing is reserved for it (Assumptions) |
| 8. Where config lives and how it is backed up | `department.yaml` and employee YAML under `org/` (operator, Q3), already in `ARCHIVE_INCLUDES` (`backup/archive.ts:9`). Last good scopes and session bindings live in the registry, carried by the registry backup (`backup/snapshot.ts:38`) |
