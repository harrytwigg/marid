# Data Model: Projects and Project-Scoped Employees

This assumes Q3-a: project definitions live in the registry DB, and employee scope lives in org
YAML.

## Registry tables

All new tables are additive and registered in `V2_ADDITIVE_TABLES`
(`packages/jinn/src/work-items/migrate.ts:520`), in this order. No column is added to
`work_items`.

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY CHECK (id GLOB 'prj_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  instructions_mode TEXT NOT NULL DEFAULT 'project' CHECK (instructions_mode IN ('project', 'project+company')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

-- Top-level Todos only (enforced in code, as sprints are). Sub-tasks read their root's row.
CREATE TABLE IF NOT EXISTS work_item_projects (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_item_projects_project ON work_item_projects(project_id);

-- Project configuration. One row per entry. The order of rows is irrelevant.
CREATE TABLE IF NOT EXISTS project_workdirs (
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,                          -- absolute, realpath-normalised at write time; FR-033 refuses $HOME, $JINN_HOME, the stage root, ~/.claude, their ancestors, and paths inside the last three
  PRIMARY KEY (project_id, path)
);
CREATE TABLE IF NOT EXISTS project_skills (
  project_id TEXT NOT NULL REFERENCES projects(id),
  skill TEXT NOT NULL,                         -- a directory name under skills/
  PRIMARY KEY (project_id, skill)
);
CREATE TABLE IF NOT EXISTS project_shared_notes (
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,                          -- relative to the home: knowledge/... or docs/...; a directory shares its subtree
  PRIMARY KEY (project_id, path)
);
CREATE TABLE IF NOT EXISTS project_env (
  project_id TEXT NOT NULL REFERENCES projects(id),
  env_name TEXT NOT NULL CHECK (env_name GLOB '[A-Z_]*' AND env_name NOT GLOB '*[^A-Z0-9_]*'),
  secret_key TEXT NOT NULL,                    -- a key NAME in the secrets store; never a value. env_name is also checked against the FR-031 reserved set at write time
  PRIMARY KEY (project_id, env_name)
);
```

Boot data check, following `sprintRowsAreSound`: every `work_item_projects.work_item_id` is a
root (`parent_id IS NULL`). A failure refuses boot, as the sprint check does.

**Reserved names**: `none` and `all`, compared ignoring case, used by the filter grammar.

**No `ALTER` on `work_items`**, so the exact-shape verifier is satisfied without a schema
generation bump.

## Sessions

These columns are added through the add-column-if-missing path
(`packages/jinn/src/sessions/migrate.ts:342`):

```sql
ALTER TABLE sessions ADD COLUMN project_id TEXT;           -- enforcement binding; set ONLY for sessions of scoped employees
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
```

The FR-013 requester is the existing `parent_session_id` (`packages/jinn/src/sessions/migrate.ts:26`),
which `spawnSession` already sets. No new column.

- **When it is set.** `project_id` is set once, in `spawnSession`, by the FR-008 rules, and
  never updated afterwards.
- **Unscoped sessions** never carry `project_id`. Their badge is derived at read time from the
  linked Todo's project (FR-009). As a result, a scoped filter
  (`project_id = P`) can never match an unscoped session.
- **No foreign key.** A dangling id is treated as an archived project: the session stays
  readable, and no new turns start.

## Events

`work_item_events.kind` gains `project_changed`, with
`detail = { from: <id|null>, to: <id|null> }`.

- Creating a Todo inside a project records `to` on the `created` event; no separate
  `project_changed` event is written.
- If a Todo leaves P while a scoped session is working on it, an `escalated` event is also
  written, naming the session.

## Org YAML: explicit scope (FR-007)

```yaml
# org/engineering/marid-dev.yaml
name: marid-dev
department: engineering
engine: claude
projects: [prj_1a2b3c4d5e6f]
persona: ...
```

| YAML | Scope |
| --- | --- |
| no `projects` key | **all** (today's behaviour) |
| `projects: [a, b]` | scoped to the known ids among `a` and `b` |
| `projects: []`, `projects:` (null), or only unknown ids | scoped to **nothing**: every scoped route refuses and no session starts |

Unknown ids are dropped from a scope without widening it.

Validation runs both at scan time (`gateway/org.ts`) and at PATCH time:

- `PATCH` refuses an empty list. Valid values are `"all"` or a non-empty list of known ids.
- The engine must be `claude` (FR-026).
- Under Q1 = B, `gateway.authRequired` must be on (FR-025).
- System employees cannot be scoped.
- A cron job cannot target a scoped employee. This is checked during cron validation.

## Derived values

- **A Todo's effective project**: `work_item_projects.project_id` for the Todo's `root_id`.
- **Project spend**: `SUM(sessions.total_cost)` over sessions linked to the project's Todos.
  It is read live, as Todo spend already is (`packages/jinn/src/work-items/store.ts:865`).
- **Scoped caller**: a capability-verified session whose employee has a scope other than
  `all`. Its project P is `sessions.project_id`.

## Stage directory (Q1 = B, built in Phase 3)

```
<parent of $JINN_HOME>/.jinn-projects/<project id>/
  CLAUDE.md            # generated from knowledge/projects/<id>/INSTRUCTIONS.md (+ company CLAUDE.md if project+company)
  .claude/skills/<s>/  # COPIES of skills/<s> for each allow-listed skill (symlinks would resolve into the denied home)
```

- **Location.** The directory sits outside `$JINN_HOME`, so ancestor `CLAUDE.md` loading
  cannot pull in the company file.
- **Sandbox settings.** The sandbox and deny rules are **not** stored here. They go in the
  gateway-written `--settings` file under `$JINN_HOME/tmp/`, and that file denies writes to
  this directory's `.claude/`, `CLAUDE.md` and `.mcp.json` (FR-022).
- **Regeneration.** The directory is rebuilt on the same triggers as `syncSkillSymlinks`, and
  on any change to the project's config. Nobody edits it by hand.

## Wire shapes

```ts
type ProjectRef = { id: string; name: string; archived: boolean };

type ProjectWire = ProjectRef & {
  description: string;
  instructionsMode: "project" | "project+company";
  workdirs: string[];
  skills: string[];
  sharedNotes: string[];
  env: Array<{ name: string; secret: string; resolved: boolean }>; // names only, never values
  members: string[];      // employees whose scope includes this project
  todoCount: number;
  spendUsd: number;
  createdAt: string; updatedAt: string; archivedAt: string | null;
};

// Additive, nullable. Added to WorkItemCompactWire / WorkItemDetailWire:
project: ProjectRef | null;
// Added to the session list and tree wire (binding for scoped sessions, derived badge otherwise):
project: ProjectRef | null;
// Added to Employee and EmployeeUpdate:
projectScope: "all" | string[];
```
