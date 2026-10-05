import type { Database as DatabaseType } from 'better-sqlite3';
import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';
import { holdLiveSignalsUntilCommit } from './live-events.js';
import type { WriteOrigin } from './origin.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Which project a Todo is in: moving one, and reading it back for a row.
 *
 * A project is a YAML file, so this module knows only project ids; whether an id
 * names a project that can take new members is the caller's `ProjectRefOf`.
 * Membership is held by TOP-LEVEL Todos only: a sub-task is in its root's
 * project, and every read goes through the root. Moving a Todo appends ONE
 * `project_changed` event naming both ends, only when membership changes.
 */

export interface ProjectRef {
  id: string;
  name: string;
  archived: boolean;
  /** False for an id with no (valid) YAML file. Such a project reads as archived. */
  known: boolean;
}

/** How the caller resolves an id to the project it names, or to a placeholder when there is none. */
export type ProjectRefOf = (projectId: string) => ProjectRef;

/** A refusal the route turns into a 4xx: `not_found` 404, the rest 400. */
export class ProjectError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'conflict' | 'invalid') {
    super(message);
    this.name = 'ProjectError';
  }
}

/** Why a project cannot take new Todos, or null when it can. */
export function closedProjectReason(ref: ProjectRef): string | null {
  if (!ref.known) return `project ${ref.id} is unknown (its definition file is missing or invalid)`;
  return ref.archived ? `project "${ref.name}" is archived and takes no new Todos` : null;
}

/** The refusal for a sub-task: it follows its root's project, never its own. */
export function subTaskProjectRefusal(subject: string, rootId: string): string {
  return `${subject}; sub-tasks follow their top-level Todo, so set the project on ${rootId}`;
}

function currentProjectOf(db: DatabaseType, workItemId: string): string | null {
  const row = db.prepare('SELECT project_id FROM work_item_projects WHERE work_item_id = ?').get(workItemId) as
    | { project_id: string }
    | undefined;
  return row?.project_id ?? null;
}

function assertTopLevel(db: DatabaseType, id: string): void {
  const item = db.prepare('SELECT parent_id, root_id FROM work_items WHERE id = ?').get(id) as
    | { parent_id: string | null; root_id: string }
    | undefined;
  if (!item) throw new ProjectError(`Todo ${id} not found`, 'not_found');
  if (item.parent_id !== null) throw new ProjectError(subTaskProjectRefusal(`${id} is a sub-task`, item.root_id), 'invalid');
}

function writeMembership(db: DatabaseType, id: string, projectId: string | null): void {
  if (projectId === null) {
    db.prepare('DELETE FROM work_item_projects WHERE work_item_id = ?').run(id);
    return;
  }
  db.prepare(
    `INSERT INTO work_item_projects (work_item_id, project_id, added_at) VALUES (?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET project_id = excluded.project_id, added_at = excluded.added_at`,
  ).run(id, projectId, new Date().toISOString());
}

/**
 * Put a top-level Todo in a project, or take it out with null. A sub-task is
 * refused, naming its root; so is an archived or unknown project as the target.
 * Leaving a project that has since been archived or lost its file is always
 * allowed. A move that changes nothing writes nothing.
 */
export function setWorkItemProject(
  workItemId: string,
  projectId: string | null,
  actor: string,
  refOf: ProjectRefOf,
  origin?: WriteOrigin,
): { project: string | null; changed: boolean } {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const txn = db.transaction((): { project: string | null; changed: boolean } => {
    assertTopLevel(db, id);
    const current = currentProjectOf(db, id);
    if (current === projectId) return { project: current, changed: false };
    if (projectId !== null) {
      const reason = closedProjectReason(refOf(projectId));
      if (reason) throw new ProjectError(reason, 'invalid');
    }
    writeMembership(db, id, projectId);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'project_changed',
      actor,
      detail: { from: current, to: projectId, ...(origin ? { origin } : {}) },
      versionEffect: 'state', // the board refetches on the version bump
    });
    return { project: projectId, changed: true };
  });
  return holdLiveSignalsUntilCommit(() => txn.immediate());
}

/**
 * Place a Todo that was just created in a project, inside the create transaction.
 * The destination is recorded on the `created` event rather than as a second
 * `project_changed` event, because the Todo never lived anywhere else.
 */
export function placeNewWorkItemInProject(workItemId: string, projectId: string, refOf: ProjectRefOf): void {
  const db = initDb();
  const id = parseTodoId(workItemId);
  assertTopLevel(db, id);
  const reason = closedProjectReason(refOf(projectId));
  if (reason) throw new ProjectError(reason, 'invalid');
  writeMembership(db, id, projectId);
  db.prepare(
    `UPDATE work_item_events SET detail = json_set(COALESCE(detail, '{}'), '$.project', ?)
     WHERE work_item_id = ? AND kind = 'created'`,
  ).run(projectId, id);
}

/** The id of the project a Todo is in (a sub-task reads its root's), or null. */
export function projectIdOf(workItemId: string): string | null {
  return projectIds([workItemId]).get(parseTodoId(workItemId)) ?? null;
}

/** Batch form: ONE query for the whole page. Every requested id is in the Map. */
export function projectIds(workItemIds: string[]): Map<string, string | null> {
  const found = new Map<string, string | null>();
  if (workItemIds.length === 0) return found;
  const ids = workItemIds.map((id) => parseTodoId(id));
  for (const id of ids) found.set(id, null);
  const rows = initDb().prepare(
    `SELECT w.id AS work_item_id, wp.project_id
     FROM work_items w JOIN work_item_projects wp ON wp.work_item_id = w.root_id
     WHERE w.id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(ids)) as Array<{ work_item_id: string; project_id: string }>;
  for (const row of rows) found.set(row.work_item_id, row.project_id);
  return found;
}

/** The project each Todo is in, as the ref Todo payloads carry; null for company-level. */
export function projectRefs(workItemIds: string[], refOf: ProjectRefOf): Map<string, ProjectRef | null> {
  const refs = new Map<string, ProjectRef | null>();
  for (const [id, projectId] of projectIds(workItemIds)) refs.set(id, projectId === null ? null : refOf(projectId));
  return refs;
}

/** Todos that name a project id, by id: the live counts the registry and the scan report on. */
export function projectTodoCounts(): Map<string, number> {
  const rows = initDb().prepare('SELECT project_id, COUNT(*) AS n FROM work_item_projects GROUP BY project_id').all() as Array<{
    project_id: string;
    n: number;
  }>;
  return new Map(rows.map((row) => [row.project_id, row.n]));
}

/** Live spend over every session linked to a project's Todos, sub-tasks included. Never stored. */
export function projectSpend(): Map<string, number> {
  const rows = initDb().prepare(
    `SELECT wp.project_id, COALESCE(SUM(s.total_cost), 0) AS spend
     FROM work_item_projects wp
     JOIN work_items w ON w.root_id = wp.work_item_id
     JOIN sessions s ON s.work_item_id = w.id
     GROUP BY wp.project_id`,
  ).all() as Array<{ project_id: string; spend: number }>;
  return new Map(rows.map((row) => [row.project_id, row.spend]));
}
