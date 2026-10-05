# Data Model: Projects and Project-Scoped Employees

Project definitions are YAML, mirroring `org/` (Q3). The registry holds only Todo membership
and the session binding. Both are keyed by the project's stable id, the same way
`work_items.assignee` names an employee.

## Project YAML

```yaml
# $JINN_HOME/projects/side-project.yaml   (file name is presentation only)
id: prj_1a2b3c4d5e6f          # required, stable, never changes
name: Side project            # unique ignoring case; "none" and "all" reserved
description: Friend's side project, on their Claude account
archived: false               # true: readable, refuses new members
dedicated: false              # true: only members may hold its Todos (FR-015)
workdirs:                     # FR-033; realpath-normalised at scan time
  - ~/Projects/side-project
skills: [review, speckit-specify, speckit-plan]   # allow-list for scoped sessions; [] or absent = none
sharedNotes: []               # paths relative to $JINN_HOME (knowledge/... or docs/...); a directory shares its subtree
instructions: project         # project | project+company (FR-029)
```

**Scan.** `gateway/project-registry.ts` scans the directory, following the shape of `scanOrg`
and `orgRegistry` (`packages/jinn/src/gateway/org-registry.ts:42`).

- It runs at boot and from a watcher on `projects/`.
- If a scan fails, it keeps the last good set.
- It refuses a file, logging the file and the reason, when the file has:
  - a missing or malformed `id`;
  - a duplicate `id` (both files are refused);
  - a duplicate or reserved `name`;
  - a `workdirs` entry that fails FR-033;
  - a `skills` entry that does not exist under `skills/`;
  - a `sharedNotes` entry outside `knowledge/` or `docs/`.

The `id` is required. Generating one on the operator's behalf would mean rewriting a file they
edited by hand. The Projects page creates files with a generated id.

**Backup.** `projects` is added to `ARCHIVE_INCLUDES`
(`packages/jinn/src/backup/archive.ts:9`).

**Writes from the UI** (FR-042). `POST /api/projects` writes a new file, and
`PATCH /api/projects/:id` rewrites that project's file. Both are operator-only, like
`PATCH /api/org/employees/:name`.

## Registry tables

New tables are additive and registered in `V2_ADDITIVE_TABLES`
(`packages/jinn/src/work-items/migrate.ts:520`). No column is added to `work_items`.

```sql
-- Top-level Todos only (enforced in code, as sprints are). Sub-tasks read their root's row.
-- project_id is not a foreign key: projects are YAML, like employees.
CREATE TABLE IF NOT EXISTS work_item_projects (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  project_id TEXT NOT NULL CHECK (project_id GLOB 'prj_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_item_projects_project ON work_item_projects(project_id);
```

A boot data check, following `sprintRowsAreSound`, requires every `work_item_id` to be a
root.

A `project_id` with no YAML is a dangling id. The project scan reports it. It is never
refused at boot, so deleting a YAML file cannot brick the gateway.

```sql
-- sessions: add-column-if-missing path (packages/jinn/src/sessions/migrate.ts:342)
ALTER TABLE sessions ADD COLUMN project_id TEXT;   -- enforcement binding; set ONLY for sessions of scoped employees
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
```

- `project_id` is set once, in `spawnSession` (FR-008), and never updated.
- The FR-013 requester is the existing `parent_session_id`
  (`packages/jinn/src/sessions/migrate.ts:26`).
- Unscoped sessions never carry `project_id`. Their badge is derived from the linked Todo.

## Events

`work_item_events.kind` gains `project_changed`, with
`detail = { from: <id|null>, to: <id|null> }`.

- Creating a Todo inside a project records `to` on the `created` event instead.
- When a Todo leaves P while a scoped session is working it, an `escalated` event is written
  as well.

## Employee YAML

```yaml
# org/engineering/side-dev.yaml
name: side-dev
engine: claude
projects: [prj_1a2b3c4d5e6f]      # absent = all (today); present = scoped to the known ids
claudeConfigDir: ~/.claude-side   # optional; local sessions run on this Claude account (FR-037)
cliFlags: ["--no-chrome"]         # recommended for someone else's account (FR-037)
mcp: false                        # optional: no third-party MCP servers; the jinn server still attaches
persona: ...
```

| YAML | Scope |
| --- | --- |
| no `projects` key | **all**: today's behaviour, and every existing employee |
| `projects: [a, b]` | scoped to whichever of `a` and `b` are known ids |
| `projects: []`, `projects:` (null), or only unknown ids | scoped to **nothing** |

**Validation** runs at scan time (`gateway/org.ts`) and at PATCH time:

- PATCH refuses an empty list.
- A scoped employee must use the `claude` engine.
- System employees cannot be scoped.
- A cron job cannot target a scoped employee.
- A PATCH that narrows scope is refused while the employee holds a Todo that would fall
  outside the new scope (FR-015).
- `claudeConfigDir` must be absolute or start with `~/`, and must not be `~/.claude` itself.
  The default account is expressed by leaving the field out.

`WRITABLE_FIELDS` (`packages/jinn/src/gateway/org.ts:170`) gains `projects` and
`claudeConfigDir`.

## Stage directory

```
<parent of $JINN_HOME>/.jinn-projects/<project id>/
  CLAUDE.md            # generated: INSTRUCTIONS.md (+ company CLAUDE.md if project+company) + the fixed scope paragraph (FR-029)
  .claude/skills/<s>/  # copies of skills/<s> for each allow-listed skill
```

The stage directory is regenerated on the same triggers as `syncSkillSymlinks`, on a project
scan change, and when an instructions file changes. Nobody edits it by hand.

## Derived values

- **A Todo's effective project**: the `work_item_projects` row for its `root_id`.
- **Project members**: the employees whose scope includes the project id.
- **Project spend**: `SUM(sessions.total_cost)` over sessions linked to the project's Todos,
  read live (`packages/jinn/src/work-items/store.ts:865`).
- **Scoped caller**: a capability-verified session whose employee's scope is not `all`. Its P
  is `sessions.project_id`.
- **Engine-health key**: the target key gains the employee's effective Claude config dir. The
  default dir keeps today's key, so existing health rows are unchanged.

## Wire shapes

```ts
type ProjectRef = { id: string; name: string; archived: boolean; known: boolean }; // known=false: dangling id

type ProjectWire = ProjectRef & {
  description: string;
  dedicated: boolean;
  instructions: "project" | "project+company";
  workdirs: string[];
  skills: string[];
  sharedNotes: string[];
  members: string[];
  todoCount: number;
  spendUsd: number;
  file: string;          // path relative to $JINN_HOME, for "edit in YAML"
};

// Additive, nullable:
// WorkItemCompactWire / WorkItemDetailWire, and the session list / tree wire:
project: ProjectRef | null;
// Employee / EmployeeUpdate:
projectScope: "all" | string[];
claudeConfigDir?: string;
```
