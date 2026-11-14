import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';
import { holdLiveSignalsUntilCommit } from './live-events.js';
import type { WriteOrigin } from './origin.js';
import { appendWorkItemEvent } from './store.js';
import {
  activeSprint,
  requireSprint,
  rowToSprint,
  SPRINT_FILTER_ACTIVE,
  SPRINT_FILTER_NONE,
  SprintError,
  type Db,
  type Sprint,
  type SprintRef,
  type SprintStatus,
} from './sprint-model.js';

/**
 * Which sprint a Todo is in: moving one, and reading it back for a row. The
 * rules (top-level Todos only, closed sprints keep their finished Todos) are
 * documented in sprints.ts.
 */

function currentSprintOf(db: Db, workItemId: string): Sprint | null {
  const row = db.prepare(
    'SELECT s.* FROM work_item_sprints ws JOIN sprints s ON s.id = ws.sprint_id WHERE ws.work_item_id = ?',
  ).get(workItemId) as Record<string, unknown> | undefined;
  return row ? rowToSprint(row) : null;
}

export interface SprintMove {
  id: string;
  from: Sprint | null;
  to: Sprint | null;
  actor: string;
  origin?: WriteOrigin;
  reason?: 'carried';
}

export function moveInTxn(db: Db, { id, from, to, actor, origin, reason }: SprintMove): void {
  if (to) {
    db.prepare(
      `INSERT INTO work_item_sprints (work_item_id, sprint_id, added_at) VALUES (?, ?, ?)
       ON CONFLICT(work_item_id) DO UPDATE SET sprint_id = excluded.sprint_id, added_at = excluded.added_at`,
    ).run(id, to.id, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM work_item_sprints WHERE work_item_id = ?').run(id);
  }
  appendWorkItemEvent({
    workItemId: id,
    kind: 'sprint_changed',
    actor,
    detail: {
      sprint: to?.name ?? null,
      from: from?.name ?? null,
      ...(reason ? { reason } : {}),
      ...(origin ? { origin } : {}),
    },
    versionEffect: 'state', // the board refetches on the version bump
  });
}

/** The refusal for a sub-task: it follows its root's sprint, never its own. */
export function subTaskSprintRefusal(subject: string, rootId: string): string {
  return `${subject}; sub-tasks follow their top-level Todo, so set the sprint on ${rootId}`;
}

/** Refuse an unknown Todo, and a sub-task, naming the root that holds its
 *  sprint. Returns the Todo's status. */
function assertTopLevel(db: Db, id: string): string {
  const item = db.prepare('SELECT parent_id, root_id, status FROM work_items WHERE id = ?').get(id) as
    | { parent_id: string | null; root_id: string; status: string }
    | undefined;
  if (!item) throw new SprintError(`Todo ${id} not found`, 'not_found');
  if (item.parent_id !== null) {
    throw new SprintError(subTaskSprintRefusal(`${id} is a sub-task`, item.root_id), 'invalid');
  }
  return item.status;
}

/** A closed sprint's finished Todos are its record of what it delivered, so
 *  they stay. A Todo reopened after its sprint closed was never carried, and
 *  may still leave. */
function assertMayLeave(current: Sprint | null, id: string, status: string): void {
  if (current?.status === 'closed' && (status === 'done' || status === 'cancelled')) {
    throw new SprintError(`${id} is ${status} in closed sprint "${current.name}", which keeps it as its record`, 'invalid');
  }
}

/** The sprint a move names, or null for none.
 *  `none` means no sprint and `active` the running one. */
function openSprintOrNull(db: Db, sprintRef: string | null): Sprint | null {
  const word = sprintRef?.trim().toLowerCase();
  if (sprintRef === null || word === SPRINT_FILTER_NONE) return null;
  if (word === SPRINT_FILTER_ACTIVE) {
    const running = activeSprint(db);
    if (!running) throw new SprintError('no sprint is active; name a planned sprint instead', 'not_found');
    return running;
  }
  return requireSprint(db, sprintRef);
}

/** Nothing new moves into a closed sprint. Checked after the no-op test, so a
 *  retried move to the closed sprint a Todo is already in answers unchanged. */
function assertMayEnter(target: Sprint | null): void {
  if (target?.status === 'closed') {
    throw new SprintError(`sprint "${target.name}" is closed; move the Todo to a planned or active sprint`, 'invalid');
  }
}

/**
 * Put a top-level Todo in a sprint (by id, name, or `active`), or take it out
 * with null or `none`. A sub-task is refused, naming its root; so is a closed
 * sprint as the target, and a finished Todo leaving a closed one. Returns
 * the sprint it now belongs to; a move that changes nothing writes nothing.
 */
export function setWorkItemSprint(workItemId: string, sprintRef: string | null, actor: string,
  origin?: WriteOrigin): { sprint: Sprint | null; changed: boolean } {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const txn = db.transaction((): { sprint: Sprint | null; changed: boolean } => {
    const status = assertTopLevel(db, id);
    const target = openSprintOrNull(db, sprintRef);
    const current = currentSprintOf(db, id);
    if ((current?.id ?? null) === (target?.id ?? null)) return { sprint: current, changed: false };
    assertMayEnter(target);
    assertMayLeave(current, id, status);
    moveInTxn(db, { id, from: current, to: target, actor, origin });
    return { sprint: target, changed: true };
  });
  return holdLiveSignalsUntilCommit(() => txn.immediate());
}

/** The sprint a Todo is in — a sub-task reads its root's. Null when none. */
export function getWorkItemSprint(workItemId: string): SprintRef | null {
  return sprintRefs([workItemId]).get(parseTodoId(workItemId)) ?? null;
}

/** Batch form for list payloads: ONE query for the page. Every requested id is
 *  in the Map (null when its root is in no sprint). */
export function sprintRefs(workItemIds: string[]): Map<string, SprintRef | null> {
  const refs = new Map<string, SprintRef | null>();
  if (workItemIds.length === 0) return refs;
  const ids = workItemIds.map((id) => parseTodoId(id));
  for (const id of ids) refs.set(id, null);
  const db = initDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT w.id AS work_item_id, s.id, s.name, s.status
     FROM work_items w
     JOIN work_item_sprints ws ON ws.work_item_id = w.root_id
     JOIN sprints s ON s.id = ws.sprint_id
     WHERE w.id IN (${placeholders})`,
  ).all(...ids) as Array<{ work_item_id: string; id: string; name: string; status: SprintStatus }>;
  for (const row of rows) refs.set(row.work_item_id, { id: row.id, name: row.name, status: row.status });
  return refs;
}
