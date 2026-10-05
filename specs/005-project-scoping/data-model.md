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
  path TEXT NOT NULL,                          -- absolute, realpath-normalised at write time
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
  secret_key TEXT NOT NULL,                    -- a key NAME in secrets/; never a value
  PRIMARY KEY (project_id, env_name)
);
```

Boot data check, following `sprintRowsAreSound`: every `work_item_projects.work_item_id` is a
root (`parent_id IS NULL`). A failure refuses boot, as the sprint check does.

**Reserved names**: `none` and `all`, compared ignoring case, used by the filter grammar.

**No `ALTER` on `work_items`**, so the exact-shape verifier is satisfied without a schema
generation bump.

## Sessions

```sql
ALTER TABLE sessions ADD COLUMN project_id TEXT;   -- via the add-column-if-missing path, sessions/migrate.ts:342
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
```

- Set once, in `spawnSession`, from the FR-008 rules. It is never updated.
- It has no foreign key, because the sessions table predates projects and uses
  add-column-if-missing. A dangling id is treated as an archived project: readable, and no new
  turns start.

## Events

`work_item_events.kind` gains `project_changed`, with
`detail = { from: <id|null>, to: <id|null> }` and `actor` as usual. Creation in a project
records `to` on the `created` event's detail rather than writing a second event.

## Org YAML

```yaml
# org/engineering/marid-dev.yaml
name: marid-dev
department: engineering
engine: claude
projects: [prj_1a2b3c4d5e6f]   # absent or [] = unrestricted (today's behaviour)
persona: ...
```

Validation runs at scan time (`gateway/org.ts`) and at PATCH time:

- every id must be a known project, or the employee is loaded **as scoped to nothing**. An
  unknown id fails closed, never open;
- the engine must be `claude` (FR-025);
- system employees may not be scoped.

## Derived values

- **A Todo's effective project**: `work_item_projects.project_id` for its `root_id`.
- **Project spend**: `SUM(sessions.total_cost) WHERE project_id = ?`, read live and never
  stored, the same way Todo spend is read at `work-items/store.ts:865`.
- **Scoped caller**: a capability-verified session whose employee has non-empty `projects`.
  Its bound project is `sessions.project_id`.

## Stage directory (Q1 = B)

```
$JINN_HOME/projects/<project id>/stage/     # or outside the home if Phase 0 item 2 fails
  CLAUDE.md            # generated: knowledge/projects/<id>/INSTRUCTIONS.md (+ company CLAUDE.md if project+company)
  .claude/skills/<s>   # symlinks to skills/<s> for each allow-listed skill
  .claude/settings.json # sandbox and deny rules (FR-022)
```

It is regenerated on the same triggers as `syncSkillSymlinks`, and on any project config change.
It is never edited by hand.

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

// Added to WorkItemCompactWire / WorkItemDetailWire:
project: ProjectRef | null;
// Added to the session list and tree wire:
project: ProjectRef | null;
// Added to Employee and EmployeeUpdate:
projects?: string[];
```
