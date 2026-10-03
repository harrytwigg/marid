import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';
import { holdLiveSignalsUntilCommit } from './live-events.js';
import type { WriteOrigin } from './origin.js';
import { appendWorkItemEvent } from './store.js';

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
 * - A closed sprint is history. Nothing new moves into it, and it cannot be
 *   deleted; only a planned sprint can, which returns its Todos to no sprint.
 * - Completing a sprint carries every UNFINISHED Todo (anything not done or
 *   cancelled) to the sprint named — or to no sprint — in the same transaction,
 *   and may start that sprint in the same move. Finished Todos stay where they
 *   were, so the closed sprint still shows what it delivered.
 * - Moving a Todo appends ONE `sprint_changed` event naming both sprints, only
 *   when membership actually changes.
 * - Sprints scope what the operator SEES. They do not scope what the board walk
 *   or the Dispatcher pick up.
 */

export type SprintStatus = 'planned' | 'active' | 'closed';

export interface Sprint {
  id: string; // spr_<12hex>
  name: string;
  goal: string | null;
  status: SprintStatus;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  startedAt: string | null;
  closedAt: string | null;
}

/** A sprint with its membership counted: `open` is every top-level Todo not yet
 *  done or cancelled, `total` every top-level Todo in it. */
export interface SprintSummary extends Sprint {
  open: number;
  total: number;
}

/** What a compact Todo row carries about its sprint. */
export interface SprintRef {
  id: string;
  name: string;
  status: SprintStatus;
}

/** Filter words the `sprint` query parameter reserves; no sprint may be named either. */
export const SPRINT_FILTER_ACTIVE = 'active';
export const SPRINT_FILTER_NONE = 'none';
const RESERVED_NAMES = new Set([SPRINT_FILTER_ACTIVE, SPRINT_FILTER_NONE]);

export const SPRINT_ID_PATTERN = /^spr_[0-9a-f]{12}$/;
export const SPRINT_NAME_MAX = 80;
export const SPRINT_GOAL_MAX = 2_000;
const FINISHED_STATUSES = "('done','cancelled')";

/** A refusal the route turns into a 4xx: `not_found` 404, `conflict` 409, the rest 400. */
export class SprintError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'conflict' | 'invalid') {
    super(message);
    this.name = 'SprintError';
  }
}

function rowToSprint(row: Record<string, unknown>): Sprint {
  return {
    id: row.id as string,
    name: row.name as string,
    goal: (row.goal as string) ?? null,
    status: row.status as SprintStatus,
    startsAt: (row.starts_at as string) ?? null,
    endsAt: (row.ends_at as string) ?? null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? null,
    closedAt: (row.closed_at as string) ?? null,
  };
}

/** Trim and collapse whitespace; refuse empty, over-long and reserved names. */
export function normalizeSprintName(name: string): string {
  const normalized = name.replace(/\s+/g, ' ').trim();
  if (!normalized) throw new SprintError('sprint name must not be empty', 'invalid');
  if (normalized.length > SPRINT_NAME_MAX) {
    throw new SprintError(`sprint name must be at most ${SPRINT_NAME_MAX} characters`, 'invalid');
  }
  if (RESERVED_NAMES.has(normalized.toLowerCase())) {
    throw new SprintError(`"${normalized}" is reserved for the sprint filter; choose another name`, 'invalid');
  }
  return normalized;
}

function normalizeGoal(goal: string | null | undefined): string | null {
  if (goal === undefined || goal === null) return null;
  const trimmed = goal.trim();
  if (trimmed.length > SPRINT_GOAL_MAX) {
    throw new SprintError(`sprint goal must be at most ${SPRINT_GOAL_MAX} characters`, 'invalid');
  }
  return trimmed || null;
}

/** Dates are calendar days (`YYYY-MM-DD`): a sprint runs on the operator's
 *  calendar, not on a timestamp. */
function normalizeDay(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new SprintError(`${field} must be a calendar date (YYYY-MM-DD)`, 'invalid');
  }
  return value;
}

function assertDayOrder(startsAt: string | null, endsAt: string | null): void {
  if (startsAt && endsAt && startsAt > endsAt) {
    throw new SprintError('startsAt must be on or before endsAt', 'invalid');
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

type Db = ReturnType<typeof initDb>;

function findSprint(db: Db, ref: string): Sprint | undefined {
  const trimmed = ref.trim();
  if (SPRINT_ID_PATTERN.test(trimmed)) {
    const row = db.prepare('SELECT * FROM sprints WHERE id = ?').get(trimmed) as Record<string, unknown> | undefined;
    if (row) return rowToSprint(row);
  }
  const row = db.prepare('SELECT * FROM sprints WHERE name = ? COLLATE NOCASE')
    .get(trimmed.replace(/\s+/g, ' ')) as Record<string, unknown> | undefined;
  return row ? rowToSprint(row) : undefined;
}

/** Resolve an id or name, or throw naming the sprints that would have been
 *  accepted — the caller is often a model reading the error and retrying. */
function requireSprint(db: Db, ref: string): Sprint {
  const sprint = findSprint(db, ref);
  if (sprint) return sprint;
  const names = (db.prepare("SELECT name FROM sprints WHERE status != 'closed' ORDER BY created_at").pluck().all() as string[]);
  throw new SprintError(
    `unknown sprint "${ref}"; open sprints: ${names.length ? names.join(', ') : '(none yet; create one first)'}`,
    'not_found',
  );
}

function activeSprint(db: Db): Sprint | undefined {
  const row = db.prepare("SELECT * FROM sprints WHERE status = 'active'").get() as Record<string, unknown> | undefined;
  return row ? rowToSprint(row) : undefined;
}

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
 *  event; an active or closed sprint is refused. Returns the ids that moved. */
export function deleteSprint(ref: string, actor: string, origin?: WriteOrigin): string[] {
  const db = initDb();
  const txn = db.transaction((): string[] => {
    const sprint = requireSprint(db, ref);
    if (sprint.status !== 'planned') {
      throw new SprintError(`only a planned sprint can be deleted; "${sprint.name}" is ${sprint.status}`, 'invalid');
    }
    const members = db.prepare('SELECT work_item_id FROM work_item_sprints WHERE sprint_id = ? ORDER BY work_item_id')
      .pluck().all(sprint.id) as string[];
    for (const id of members) moveInTxn(db, { id, from: sprint, to: null, actor, origin });
    db.prepare('DELETE FROM sprints WHERE id = ?').run(sprint.id);
    return members;
  });
  return holdLiveSignalsUntilCommit(() => txn.immediate());
}

function currentSprintOf(db: Db, workItemId: string): Sprint | null {
  const row = db.prepare(
    'SELECT s.* FROM work_item_sprints ws JOIN sprints s ON s.id = ws.sprint_id WHERE ws.work_item_id = ?',
  ).get(workItemId) as Record<string, unknown> | undefined;
  return row ? rowToSprint(row) : null;
}

interface SprintMove {
  id: string;
  from: Sprint | null;
  to: Sprint | null;
  actor: string;
  origin?: WriteOrigin;
  reason?: 'carried';
}

function moveInTxn(db: Db, { id, from, to, actor, origin, reason }: SprintMove): void {
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

/** Refuse an unknown Todo, and a sub-task, naming the root that holds its sprint. */
function assertTopLevel(db: Db, id: string): void {
  const item = db.prepare('SELECT parent_id, root_id FROM work_items WHERE id = ?').get(id) as
    | { parent_id: string | null; root_id: string }
    | undefined;
  if (!item) throw new SprintError(`Todo ${id} not found`, 'not_found');
  if (item.parent_id !== null) {
    throw new SprintError(`${id} is a sub-task; sub-tasks follow their top-level Todo, so set the sprint on ${item.root_id}`, 'invalid');
  }
}

/** The sprint a move goes to — never a closed one — or null for none. */
function openSprintOrNull(db: Db, sprintRef: string | null): Sprint | null {
  if (sprintRef === null) return null;
  const target = requireSprint(db, sprintRef);
  if (target.status === 'closed') {
    throw new SprintError(`sprint "${target.name}" is closed; move the Todo to a planned or active sprint`, 'invalid');
  }
  return target;
}

/**
 * Put a top-level Todo in a sprint (by id or name), or take it out with null.
 * A sub-task is refused, naming its root, and so is a closed sprint. Returns
 * the sprint it now belongs to; a move that changes nothing writes nothing.
 */
export function setWorkItemSprint(workItemId: string, sprintRef: string | null, actor: string,
  origin?: WriteOrigin): { sprint: Sprint | null; changed: boolean } {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const txn = db.transaction((): { sprint: Sprint | null; changed: boolean } => {
    assertTopLevel(db, id);
    const target = openSprintOrNull(db, sprintRef);
    const current = currentSprintOf(db, id);
    if ((current?.id ?? null) === (target?.id ?? null)) return { sprint: current, changed: false };
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
