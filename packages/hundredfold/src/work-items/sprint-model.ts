import { initDb } from '../shared/db.js';

/**
 * Sprints' shared vocabulary: the shapes, the name/goal/date rules, the refusal
 * the routes map to a 4xx, and the lookups every sprint write starts from. The
 * semantics are documented in sprints.ts.
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
export const FINISHED_STATUSES = "('done','cancelled')";

/** A refusal the route turns into a 4xx: `not_found` 404, `conflict` 409, the rest 400. */
export class SprintError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'conflict' | 'invalid') {
    super(message);
    this.name = 'SprintError';
  }
}

export function rowToSprint(row: Record<string, unknown>): Sprint {
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
  // A name shaped like an id would match two sprints in the `id = ? OR name = ?` filter.
  if (SPRINT_ID_PATTERN.test(normalized.toLowerCase())) {
    throw new SprintError(`"${normalized}" looks like a sprint id; choose another name`, 'invalid');
  }
  return normalized;
}

export function normalizeGoal(goal: string | null | undefined): string | null {
  if (goal === undefined || goal === null) return null;
  const trimmed = goal.trim();
  if (trimmed.length > SPRINT_GOAL_MAX) {
    throw new SprintError(`sprint goal must be at most ${SPRINT_GOAL_MAX} characters`, 'invalid');
  }
  return trimmed || null;
}

/** Dates are calendar days (`YYYY-MM-DD`): a sprint runs on the operator's
 *  calendar, not on a timestamp. */
export function normalizeDay(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  // A shape-valid but impossible day (2026-13-45) is an Invalid Date, whose
  // toISOString throws; it must refuse as a bad date, never escape as a 500.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SprintError(`${field} must be a calendar date (YYYY-MM-DD)`, 'invalid');
  }
  return value;
}

export function assertDayOrder(startsAt: string | null, endsAt: string | null): void {
  if (startsAt && endsAt && startsAt > endsAt) {
    throw new SprintError('startsAt must be on or before endsAt', 'invalid');
  }
}

export function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export type Db = ReturnType<typeof initDb>;

export function findSprint(db: Db, ref: string): Sprint | undefined {
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
export function requireSprint(db: Db, ref: string): Sprint {
  const sprint = findSprint(db, ref);
  if (sprint) return sprint;
  const names = (db.prepare("SELECT name FROM sprints WHERE status != 'closed' ORDER BY created_at").pluck().all() as string[]);
  throw new SprintError(
    `unknown sprint "${ref}"; open sprints: ${names.length ? names.join(', ') : '(none yet; create one first)'}`,
    'not_found',
  );
}

export function activeSprint(db: Db): Sprint | undefined {
  const row = db.prepare("SELECT * FROM sprints WHERE status = 'active'").get() as Record<string, unknown> | undefined;
  return row ? rowToSprint(row) : undefined;
}
