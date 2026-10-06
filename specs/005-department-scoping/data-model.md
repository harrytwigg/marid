# Data Model: Department-Scoped Employees and Per-Employee Claude Profiles

Scope is part of a department's definition, in YAML beside its employees (Q3, D1). The
registry keeps what it already keeps (`work_items.department`, the `departments` prefix table)
and gains one small table for last good scopes, plus one `sessions` column for the binding.

## Department YAML

```yaml
# $JINN_HOME/org/side-project/department.yaml
name: side-project            # must equal the directory name
displayName: Side project
description: Friend's side project
scope: scoped                 # open (default, also when absent) | scoped | dedicated
workdirs:                     # FR-033; realpath-normalised at scan time
  - ~/Projects/side-project
skills: [review, speckit-specify, speckit-plan]   # allow-list for scoped sessions; [] or absent = none
sharedNotes: []               # paths relative to $JINN_HOME (knowledge/... or docs/...); a directory shares its subtree
instructions: department      # department | department+company (FR-029)
```

| `scope` | Its members | Everyone else |
| --- | --- | --- |
| `open` (or absent) | Unscoped: today's behaviour | Today's behaviour |
| `scoped` | Confined to this department | May read, comment on and hold its Todos |
| `dedicated` | Confined to this department | May read and comment, but not hold its Todos |

`workdirs`, `skills`, `sharedNotes` and `instructions` are read only when the scope is not
`open`.

**Scan.** `gateway/department-registry.ts` follows the shape of `refreshOrg`
(`packages/jinn/src/gateway/org-registry.ts:42`). It runs with the org scan, at boot and from
the existing `org/` watcher (`packages/jinn/src/gateway/watcher.ts:130`). The org walker keeps
skipping `department.yaml` as an employee file (`packages/jinn/src/gateway/org.ts:31`). FR-001
sets the rules:

- **Identity problems** refuse the file: YAML that does not parse, a `name` that does not
  match the directory, an unknown `scope`, or a non-open scope on `system`. The department
  keeps its last good scope. With none recorded, it is treated as `dedicated` only if the raw
  text has a `scope:` key with a value other than `open` (FR-001); otherwise the department
  stays `open`.
- **Content problems** drop only the bad entry, with a warning: a missing skill, an FR-033
  `workdirs` failure, or a `sharedNotes` entry outside `knowledge/` or `docs/`.
- **No `department.yaml`**: the department keeps its last good scope. With none recorded, it
  is `open`, which is every department today.

**Backup.** `org` is already in `ARCHIVE_INCLUDES` (`packages/jinn/src/backup/archive.ts:9`).

**Writes from the UI** (FR-042): `PATCH /api/departments/:slug` rewrites that file (or creates
it in an existing department directory). It is operator-only, like
`PATCH /api/org/employees/:name`. Writes are atomic: a temp file in the same directory, then a
rename. The in-memory definitions are refreshed before the response returns.

## Registry tables

New tables are additive and registered in `V2_ADDITIVE_TABLES`
(`packages/jinn/src/work-items/migrate.ts:520`). No column is added to `work_items` or
`departments`.

```sql
-- The last scope each department loaded with (FR-001). A refused or deleted department.yaml
-- keeps this value, so a broken file never opens a scoped department.
CREATE TABLE IF NOT EXISTS department_scopes (
  slug TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('open', 'scoped', 'dedicated')),
  recorded_at TEXT NOT NULL
);
```

Every successful load of a `department.yaml` upserts its row. A department with no row and no
file is `open`. The row is never deleted by the scan. The operator opens a department by
writing `scope: open`, which upserts `open`.

```sql
-- sessions: add-column-if-missing path (packages/jinn/src/sessions/migrate.ts:342)
ALTER TABLE sessions ADD COLUMN scope_department TEXT;   -- enforcement binding; set ONLY for sessions of scoped employees
CREATE INDEX IF NOT EXISTS idx_sessions_scope_department ON sessions(scope_department);
```

- `scope_department` is set once, in `spawnSession` (FR-008), and never updated.
- The FR-013 requester is the existing `parent_session_id`
  (`packages/jinn/src/sessions/migrate.ts:26`).
- Unscoped sessions never carry `scope_department`. Their badge is derived from the linked
  Todo.

## Events

No new event kind. A department change already records through the metadata edit. When a Todo
leaves D while a scoped session is working it, an `escalated` event is written as well.

## Employee YAML

```yaml
# org/side-project/side-dev.yaml
name: side-dev
department: side-project            # optional: defaults to the directory; must match it when either is non-open
engine: claude
claudeConfigDir: /Users/operator/.claude-friend   # optional, local employees only (FR-050)
mcp: false                          # optional: no third-party MCP servers; the jinn server still attaches
persona: ...
```

**Validation** runs at scan time (`gateway/org.ts`) and at PATCH time:

- Scope is read from the top-level directory under `org/`. When that directory, the
  immediate directory or the `department` field names a non-open department, all three must
  agree (FR-007).
- A scoped employee must use the `claude` engine (FR-026). It may set `remoteHost`; until
  Phase 5 that is refused. Its `remoteCwd` must not be, contain or lie inside
  `<remote.root>/.jinn-departments` or `remote.mount`, nor (checked at spawn) the per-host
  stage root (FR-061).
- `claudeConfigDir` must be absolute, must not start with `~`, must not lie inside
  `$JINN_HOME`, must not equal the default profile's directory, and is refused alongside
  `remoteHost` (FR-050). It is canonicalised at load: no trailing slash, no `.` or `..`. It
  does not depend on the employee's department (FR-059).
- A cron job cannot target a scoped employee.
- A PATCH that changes `department` into or out of a non-open department is refused while the
  employee holds a Todo it could no longer hold (FR-015).

`claudeConfigDir` is not added to `WRITABLE_FIELDS` (`packages/jinn/src/gateway/org.ts:170`).
The department field already is.

A scoped session's engine environment also carries `JINN_DEPARTMENT=<slug>` (FR-028).

## Stage directory

```
<parent of $JINN_HOME>/.jinn-departments/<basename of $JINN_HOME>/<slug>/
  CLAUDE.md            # generated: INSTRUCTIONS.md (+ company CLAUDE.md if department+company) + the fixed scope paragraph (FR-029)
  .claude/skills/<s>/  # copies of skills/<s> for each allow-listed skill
```

The stage directory is synced (FR-020a) on the same triggers as `syncSkillSymlinks`, on a
department scan change, when an instructions file changes, and before every scoped spawn. A
sync keeps its path and inode: changed files are renamed in from
`.jinn-departments/<basename of $JINN_HOME>/.<slug>.incoming-<random>/`, and extras are removed
afterwards. Nobody edits it by hand. The root is the instance's own, so two instances under one
parent do not share a stage directory. A stage directory made at the old path,
`.jinn-departments/<slug>/`, is renamed to the new one once (its inode kept) and its Claude
transcripts follow it to the new project key (FR-020a). `INSTRUCTIONS.md` is written by the
operator only (FR-029a).

**On a remote host** (FR-060), the same content is synced the same way to
`<remote.root>/.jinn-departments/<slug>/` before every scoped spawn there. Nothing is cached.
The remote path is not keyed by instance: `remote.root` is the instance's own on that host (FR-020).
A scoped remote session's `$JINN_HOME` holds only `gateway.json`, `tmp/` and the stage marker
(FR-062).

## Claude profiles

| Thing | Default profile (no `claudeConfigDir`) | Named profile |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` in the session | The gateway's own, as today | The profile path |
| `.claude.json` (trust) | `claudeJsonPath()`, as today | `<profile>/.claude.json` |
| Transcripts | `<config>/projects/<slug>` | `<profile>/projects/<slug>` |
| macOS Keychain entry | `Claude Code-credentials` | `Claude Code-credentials-<first 8 hex of sha256(profile path)>` |
| Auth outage scope | `local` (`packages/jinn/src/shared/claude-auth-outage.ts:18`) | `local:<profile key>` |
| Engine health and rate-limit memory | Engine key, as today | Engine key plus profile key |
| Limits reading | As today | Its own live reading, plan and history (Phase 6, FR-071) |

**Profile key**: the first 8 hex characters of sha256 of the canonical `claudeConfigDir`
string, NFC-normalised as Claude Code does. That string is exactly what the session receives
as `CLAUDE_CONFIG_DIR`, because Claude Code hashes the raw value and does not resolve it. This
is the same suffix Claude Code uses. One helper, `shared/claude-profile.ts`, computes it, and every
keyed store uses that helper.

## Derived values

- **A Todo's scope department**: the department of its root.
- **Department members**: the employees whose resolved department is that slug.
- **Scoped caller**: a capability-verified session whose employee's department is not open.
  Its D is `sessions.scope_department`.
- **Department spend**: `SUM(sessions.total_cost)` over sessions linked to the department's
  Todos, read live (`packages/jinn/src/work-items/store.ts:865`).

## Wire shapes

```ts
type DepartmentScope = "open" | "scoped" | "dedicated";

// GET /api/departments rows gain (additive):
scope: DepartmentScope;
displayName: string | null;
description: string | null;
members: string[];
definitionFile: string | null;   // path relative to $JINN_HOME, for "edit in YAML"
definitionError: string | null;  // set when department.yaml was refused; scope is then the last good one

// GET /api/departments/:slug (new, operator and unscoped callers):
type DepartmentDefinitionWire = {
  slug: string; scope: DepartmentScope; displayName: string | null; description: string | null;
  workdirs: string[]; skills: string[]; sharedNotes: string[];
  instructions: "department" | "department+company";
  members: string[]; todoCount: number; spendUsd: number;
  definitionFile: string | null; definitionError: string | null;
};

// Additive, nullable:
// session list / tree wire:
scopeDepartment: string | null;
// Employee wire:
claudeProfile: { path: string; key: string } | null;

// GET /api/engine-limits gains (additive; engines.claude stays the default account):
accounts?: Record<string /* engine */, Array<EngineLimitEngineSnapshot & {
  account: string;            // "claude", "claude:<key>", "claude@<user>@<host>[:<key>]" (FR-070)
  noReading?: true;           // no live reading: an expired token, a sleeping remote host or a locked remote Keychain (FR-075a)
  label: string;              // e.g. ".claude-friend" or the host
  location: { kind: "local" } | { kind: "remote"; host: string };
  employees: string[];
}>>;

// GET /api/auto-dispatch/usage?account=<key>  (default: the default account)
```

## Account fallback chains (Phase 6, FR-079)

```yaml
# config.yaml
engines:
  claude:
    fallback: [codex]            # the default account's chain, unchanged
    accounts:                    # optional; an undeclared named profile has no fallback
      friend:
        configDir: /Users/operator/.claude-friend    # matched to employees' claudeConfigDir
        fallback: []             # wait for its own reset
      work2:
        configDir: /Users/operator/.claude-work2
        fallback: [claude, codex]    # may fall back to the default account, then codex
        fallbackModelMap: {}
```

A chain entry is an engine name or an account: `claude` for the default, `claude:<name>` for a
declared one. Validation follows `validateEngineFallbackChains`: unknown names and
self-references are refused, and cycles are tolerated.

## Per-account state (Phase 6)

| Store | Default account | Other accounts |
| --- | --- | --- |
| Engine health (`tmp/engine-health.json`) | Today's `claude` record | A record per account key |
| Rate-limit memory (`tmp/claude-usage.json`) | Today's file | A record per account key |
| Usage history (`tmp/engine-limits/claude-usage-history.json`) | Today's file | One file per account key beside it |
| Status-line snapshots (`tmp/engine-limits/claude/`) | Unchanged | Same directory, filtered by the writing session's account |
| Board walk `priorFiveHour` | Today's field | A map by account key |
