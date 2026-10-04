import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { holdLiveSignalsUntilCommit } from './live-events.js';
import type { WriteOrigin } from './origin.js';
import { moveInTxn } from './sprint-membership.js';
import {
  activeSprint,
  assertDayOrder,
  FINISHED_STATUSES,
  findSprint,
  isUniqueConstraintError,
  normalizeDay,
  normalizeGoal,
  normalizeSprintName,
  requireSprint,
  rowToSprint,
  SprintError,
  type Db,
  type Sprint,
  type SprintSummary,
} from './sprint-model.js';

export {
  normalizeSprintName,
  SPRINT_FILTER_ACTIVE,
  SPRINT_FILTER_NONE,
  SPRINT_GOAL_MAX,
  SPRINT_ID_PATTERN,
  SPRINT_NAME_MAX,
  SprintError,
  type Sprint,
  type SprintRef,
  type SprintStatus,
  type SprintSummary,
} from './sprint-model.js';
export { getWorkItemSprint, setWorkItemSprint, sprintRefs } from './sprint-membership.js';

/**
 * Sprints — named, time-boxed groups of Todos the board can be scoped to.
 *
 * Semantics (design decisions):
 * - A sprint is `planned`, then `active`, then `closed`. At most ONE sprint is
 *   active at a time; the partial unique index makes a second unforgeable, and
 *   starting one while another runs is refused, naming the one to complete.
 * - A Todo belongs to at most one sprint. Membership is held by TOP-LEVEL Todos
 *   only: a sub-task travels with its root, and every sprint filter reads the
 *   root's membership, so a tree is never split across two sprints.
 * - A closed sprint is history. Nothing new moves into it, its finished Todos
 *   cannot leave it, and it cannot be deleted; only a planned sprint can,
 *   which returns its Todos to no sprint.
 * - Completing a sprint carries every UNFINISHED Todo (anything not done or
 *   cancelled) to the sprint named — or to no sprint — in the same transaction,
 *   and may start that sprint in the same move. Finished Todos stay where they
 *   were, so the closed sprint still shows what it delivered.
 * - Moving a Todo appends ONE `sprint_changed` event naming both sprints, only
 *   when membership actually changes.
 * - Sprints scope what the operator SEES. They do not scope what the board walk
 *   or the Dispatcher pick up.
 */

/** One sprint by id or name, or undefined. */
export function getSprint(ref: string): Sprint | undefined {
  return findSprint(initDb(), ref);
}

/** Every sprint with its counts: the active one first, then planned in creation
 *  order, then closed most recent first. One query for the counts. */
export function listSprints(): SprintSummary[] {
  const db = initDb();
  const rows = db.prepare(
    `SELECT s.*,
            COUNT(w.id) AS total,
            COALESCE(SUM(CASE WHEN w.status NOT IN ${FINISHED_STATUSES} THEN 1 ELSE 0 END), 0) AS open
     FROM sprints s
     LEFT JOIN work_item_sprints ws ON ws.sprint_id = s.id
     LEFT JOIN work_items w ON w.id = ws.work_item_id AND w.parent_id IS NULL
     GROUP BY s.id
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
              CASE WHEN s.status = 'closed' THEN s.closed_at END DESC,
              s.created_at ASC, s.id ASC`,
  ).all() as Record<string, unknown>[];
  return rows.map((row) => ({ ...rowToSprint(row), open: Number(row.open), total: Number(row.total) }));
}

/** Create a planned sprint. A name already taken (case-insensitively) is a
 *  conflict, not a silent return of the existing one: two people planning
 *  "Sprint 12" separately should find out. */
export function createSprint(input: { name: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null }): Sprint {
  const db = initDb();
  const name = normalizeSprintName(input.name);
  const startsAt = normalizeDay(input.startsAt, 'startsAt');
  const endsAt = normalizeDay(input.endsAt, 'endsAt');
  assertDayOrder(startsAt, endsAt);
  const sprint: Sprint = {
    id: `spr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name,
    goal: normalizeGoal(input.goal),
    status: 'planned',
    startsAt,
    endsAt,
    createdAt: new Date().toISOString(),
    startedAt: null,
    closedAt: null,
  };
  try {
    db.prepare(
      `INSERT INTO sprints (id, name, goal, status, starts_at, ends_at, created_at, started_at, closed_at)
       VALUES (?, ?, ?, 'planned', ?, ?, ?, NULL, NULL)`,
    ).run(sprint.id, sprint.name, sprint.goal, sprint.startsAt, sprint.endsAt, sprint.createdAt);
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new SprintError(`a sprint named "${name}" already exists`, 'conflict');
    throw err;
  }
  return sprint;
}

/** Rename a sprint or change its goal or dates. A closed sprint keeps its name
 *  and dates — it is history — but its goal stays editable. */
export function updateSprint(
  ref: string,
  patch: { name?: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null },
): Sprint {
  const db = initDb();
  const txn = db.transaction((): Sprint => {
    const current = requireSprint(db, ref);
    const next = patchedSprint(current, patch);
    try {
      db.prepare('UPDATE sprints SET name = ?, goal = ?, starts_at = ?, ends_at = ? WHERE id = ?')
        .run(next.name, next.goal, next.startsAt, next.endsAt, current.id);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new SprintError(`a sprint named "${next.name}" already exists`, 'conflict');
      throw err;
    }
    return next;
  });
  return txn.immediate();
}

/** The sprint a patch leaves behind, validated; a closed sprint's name and dates are frozen. */
function patchedSprint(
  current: Sprint,
  patch: { name?: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null },
): Sprint {
  const next = { ...current };
  if (patch.name !== undefined) next.name = normalizeSprintName(patch.name);
  if (patch.goal !== undefined) next.goal = normalizeGoal(patch.goal);
  if (patch.startsAt !== undefined) next.startsAt = normalizeDay(patch.startsAt, 'startsAt');
  if (patch.endsAt !== undefined) next.endsAt = normalizeDay(patch.endsAt, 'endsAt');
  assertDayOrder(next.startsAt, next.endsAt);
  const frozenChanged = next.name !== current.name || next.startsAt !== current.startsAt || next.endsAt !== current.endsAt;
  if (current.status === 'closed' && frozenChanged) {
    throw new SprintError(`sprint "${current.name}" is closed; only its goal can change`, 'invalid');
  }
  return next;
}

function startInTxn(db: Db, sprint: Sprint): Sprint {
  if (sprint.status === 'active') return sprint;
  if (sprint.status === 'closed') throw new SprintError(`sprint "${sprint.name}" is closed and cannot be restarted`, 'invalid');
  const running = activeSprint(db);
  if (running) {
    throw new SprintError(`sprint "${running.name}" is still active; complete it before starting "${sprint.name}"`, 'conflict');
  }
  const startedAt = new Date().toISOString();
  db.prepare("UPDATE sprints SET status = 'active', started_at = ? WHERE id = ?").run(startedAt, sprint.id);
  return { ...sprint, status: 'active', startedAt };
}

/** Start a planned sprint. Starting the active one again is a no-op. */
export function startSprint(ref: string): Sprint {
  const db = initDb();
  return db.transaction((): Sprint => startInTxn(db, requireSprint(db, ref))).immediate();
}

export interface CompleteSprintResult {
  sprint: Sprint;
  /** Top-level Todos moved out, in id order. */
  carried: string[];
  /** Where they went: the sprint they now belong to, or null for none. */
  carriedTo: Sprint | null;
}

/**
 * Close the active sprint and carry its unfinished Todos forward to `carryTo`
 * (a planned sprint, by id or name) or, when it is null, out of any sprint.
 * `startNext` starts `carryTo` in the same transaction, so there is no moment
 * with the work carried and no sprint running.
 */
export function completeSprint(
  ref: string,
  options: { carryTo: string | null; startNext?: boolean },
  actor: string,
  origin?: WriteOrigin,
): CompleteSprintResult {
  const db = initDb();
  const txn = db.transaction((): CompleteSprintResult => {
    const sprint = requireSprint(db, ref);
    if (sprint.status !== 'active') {
      throw new SprintError(`only the active sprint can be completed; "${sprint.name}" is ${sprint.status}`, 'invalid');
    }
    const target = carryTarget(db, sprint, options);
    const closedAt = new Date().toISOString();
    db.prepare("UPDATE sprints SET status = 'closed', closed_at = ? WHERE id = ?").run(closedAt, sprint.id);
    const carried = db.prepare(
      `SELECT w.id FROM work_item_sprints ws JOIN work_items w ON w.id = ws.work_item_id
       WHERE ws.sprint_id = ? AND w.parent_id IS NULL AND w.status NOT IN ${FINISHED_STATUSES}
       ORDER BY w.id`,
    ).pluck().all(sprint.id) as string[];
    for (const id of carried) moveInTxn(db, { id, from: sprint, to: target, actor, origin, reason: 'carried' });
    const carriedTo = target && options.startNext ? startInTxn(db, target) : target;
    return { sprint: { ...sprint, status: 'closed', closedAt }, carried, carriedTo };
  });
  return holdLiveSignalsUntilCommit(() => txn.immediate());
}

/** Where a completing sprint's unfinished work goes: a planned sprint, or null for none. */
function carryTarget(db: Db, sprint: Sprint, options: { carryTo: string | null; startNext?: boolean }): Sprint | null {
  if (options.carryTo === null) {
    if (options.startNext) throw new SprintError('startNext needs a sprint to carry the work to', 'invalid');
    return null;
  }
  const target = requireSprint(db, options.carryTo);
  if (target.id === sprint.id) throw new SprintError('cannot carry a sprint\'s work into itself', 'invalid');
  if (target.status !== 'planned') {
    throw new SprintError(`unfinished work can only be carried to a planned sprint; "${target.name}" is ${target.status}`, 'invalid');
  }
  return target;
}

/** Delete a planned sprint. Its Todos return to no sprint, each with its own
 *  event; an active or closed sprint is refused. Returns the deleted sprint's
 *  id (the caller may have named it) and the Todos that moved. */
export function deleteSprint(ref: string, actor: string, origin?: WriteOrigin): { sprintId: string; moved: string[] } {
  const db = initDb();
  const txn = db.transaction((): { sprintId: string; moved: string[] } => {
    const sprint = requireSprint(db, ref);
    if (sprint.status !== 'planned') {
      throw new SprintError(`only a planned sprint can be deleted; "${sprint.name}" is ${sprint.status}`, 'invalid');
    }
    const members = db.prepare('SELECT work_item_id FROM work_item_sprints WHERE sprint_id = ? ORDER BY work_item_id')
      .pluck().all(sprint.id) as string[];
    for (const id of members) moveInTxn(db, { id, from: sprint, to: null, actor, origin });
    db.prepare('DELETE FROM sprints WHERE id = ?').run(sprint.id);
    return { sprintId: sprint.id, moved: members };
  });
  return holdLiveSignalsUntilCommit(() => txn.immediate());
}
