import type { Database as DatabaseType } from "better-sqlite3";

/** Projects group Todos. A project is defined by a YAML file, like an employee, so
 *  the registry holds only which Todo belongs to which project id and which ids
 *  the scan has seen. Additive tables, never columns on `work_items`: the boot
 *  verifier refuses any drift in an existing table, and an older build ignores a
 *  table it does not know, which keeps a rollback safe. */

/** A top-level Todo's project, by id. `project_id` is not a foreign key: the
 *  project is a file. Only roots hold a row (the write path refuses a sub-task;
 *  every filter reads the root's). */
export const WORK_ITEM_PROJECTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_projects (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  project_id   TEXT NOT NULL CHECK (project_id GLOB 'prj_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  added_at     TEXT NOT NULL
)`;

export const WORK_ITEM_PROJECTS_DDL = `
${WORK_ITEM_PROJECTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_work_item_projects_project ON work_item_projects(project_id);
`;

/** Ids the project scan has seen, so an id that comes back under another name can be reported. */
export const PROJECT_IDS_SEEN_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS project_ids_seen (
  project_id   TEXT PRIMARY KEY,
  last_name    TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
)`;

/** What migrate.ts registers: the exact-shape DDL and the DDL that creates the table (with its index). */
export const PROJECT_TABLES: ReadonlyArray<{ name: string; ddl: string; tableDdl: string }> = [
  { name: "work_item_projects", ddl: WORK_ITEM_PROJECTS_DDL, tableDdl: WORK_ITEM_PROJECTS_TABLE_DDL },
  { name: "project_ids_seen", ddl: PROJECT_IDS_SEEN_TABLE_DDL, tableDdl: PROJECT_IDS_SEEN_TABLE_DDL },
];

/** Boot verification: every membership row names a live top-level Todo. A project
 *  id with no file is NOT checked here: a deleted YAML must never brick the boot. */
export function projectRowsAreSound(db: DatabaseType, isLiveRoot: (id: string) => boolean): boolean {
  const ids = db.prepare("SELECT work_item_id FROM work_item_projects").pluck().all() as string[];
  return ids.every(isLiveRoot);
}

/** The `project` list filter as a WHERE condition. Membership is held by the
 *  root, so a sub-task is in its root's project. `none` is in no project;
 *  anything else is a project id (a dangling one matches the Todos that still name it). */
export function projectFilterCondition(project: string): { sql: string; values: string[] } {
  if (project === "none") {
    return { sql: "NOT EXISTS (SELECT 1 FROM work_item_projects wp WHERE wp.work_item_id = work_items.root_id)", values: [] };
  }
  return {
    sql: "EXISTS (SELECT 1 FROM work_item_projects wp WHERE wp.work_item_id = work_items.root_id AND wp.project_id = ?)",
    values: [project],
  };
}
