import type { Database as DatabaseType } from 'better-sqlite3';
import { initDb } from '../shared/db.js';
import type { Session } from '../shared/types.js';
import { getSession, listSessionsByWorkItem } from '../sessions/registry.js';
import { isLegacyWorkflowPhaseSession } from '../sessions/legacy-workflow-phase.js';
import { isTerminalSession } from '../terminals/session.js';
import { toWorkItemLinkRole } from './link-role.js';

/**
 * One session per employee per Todo, whatever started it.
 *
 * A mention, a delegation and the Dispatcher's hand-off all start an
 * employee's session on a Todo. Each asking "does this employee already have
 * one?" and then spawning is two facts with a gap between them, and two
 * near-simultaneous mentions fit in it. So the answer is one row per (Todo,
 * employee), and a start takes it with a compare-and-swap: the session that
 * wins the row is the employee's session on the Todo, and every later start
 * delivers into it instead of spawning beside it.
 *
 * The row also says who the session reports to. A delegation that lands in a
 * session somebody else started makes its delegator the one that session
 * reports to from the turn that runs its brief (`employee-session-delegation.ts`);
 * the session's own parent is left as it was, and is not woken.
 *
 * A table of its own, created lazily and never in `REQUIRED_TABLE_SQL`, for the
 * same reason as the claims and comment-meta tables: the boot verifier compares
 * the Todo DB's shape byte for byte, so only an additive table it does not know
 * about survives on an existing database.
 */

export interface EmployeeSessionRecord {
  workItemId: string;
  employee: string;
  sessionId: string;
  /** Who the session reports to, once a delegation has landed in it: a session
   *  id, or null when the operator delegated (nobody to call back). */
  delegatorSessionId: string | null;
  /** Set once a delegation has landed in the session; until then the session
   *  reports to its own parent. */
  delegatedAt: string | null;
}

interface RecordRow {
  work_item_id: string;
  employee: string;
  session_id: string;
  delegator_session_id: string | null;
  delegated_at: string | null;
}

const ready = new WeakSet<DatabaseType>();

/** The record's table, created on first use. */
export function employeeSessionsTable(): DatabaseType {
  const db = initDb();
  if (ready.has(db)) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS work_item_employee_sessions (
    work_item_id         TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    employee             TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    delegator_session_id TEXT,
    delegated_at         TEXT,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (work_item_id, employee)
  )`);
  ready.add(db);
  return db;
}

export function getEmployeeSessionRecord(workItemId: string, employee: string): EmployeeSessionRecord | undefined {
  const row = employeeSessionsTable()
    .prepare('SELECT * FROM work_item_employee_sessions WHERE work_item_id = ? AND employee = ?')
    .get(workItemId, employee) as RecordRow | undefined;
  if (!row) return undefined;
  return {
    workItemId: row.work_item_id,
    employee: row.employee,
    sessionId: row.session_id,
    delegatorSessionId: row.delegator_session_id,
    delegatedAt: row.delegated_at,
  };
}

/**
 * Whether `session` counts as `employee`'s session on this Todo: linked to it,
 * that employee's, and it can still be messaged. Idle, waiting and interrupted
 * all count — a session from days ago is resumed on purpose, so the employee
 * keeps the Todo's context and is never started twice.
 */
export function isLiveEmployeeSession(session: Session | undefined, workItemId: string, employee: string): session is Session {
  return !!session
    && session.employee === employee
    && session.workItemId === workItemId
    && canMessageSession(session)
    && !isLegacyWorkflowPhaseSession(session);
}

/** Neither errored nor archived, not a terminal, and not a session reset with
 *  /new, which stays linked only as evidence of what it did. */
export function canMessageSession(session: Session): boolean {
  return session.status !== 'error'
    && !session.archivedAt
    && !session.sessionKey?.startsWith('archived:')
    && !isTerminalSession(session);
}

/**
 * Take the row for `sessionId`, but only if it still holds `expected` (null:
 * only if there is no row). `true` means this caller's session is now the
 * employee's on the Todo. Replacing the session clears who it reported to: the
 * new one has not been delegated anything yet.
 */
export function swapEmployeeSession(workItemId: string, employee: string, expected: string | null, sessionId: string): boolean {
  return employeeSessionsTable().prepare(
    `INSERT INTO work_item_employee_sessions (work_item_id, employee, session_id, updated_at)
     VALUES (:workItemId, :employee, :sessionId, :now)
     ON CONFLICT(work_item_id, employee) DO UPDATE SET
       session_id = excluded.session_id, delegator_session_id = NULL, delegated_at = NULL, updated_at = excluded.updated_at
     WHERE work_item_employee_sessions.session_id = :expected`,
  ).run({ workItemId, employee, sessionId, expected, now: new Date().toISOString() }).changes === 1;
}

const isConsult = (session: Session): boolean => toWorkItemLinkRole(session.workItemRole) === 'consult';

/** The live linked session to adopt: one working the Todo first, else the
 *  recorded consultation, else the newest live one. */
function adoptable(workItemId: string, employee: string, recordedLive: Session | undefined): Session | undefined {
  const live = listSessionsByWorkItem(workItemId).filter((session) => isLiveEmployeeSession(session, workItemId, employee));
  return live.find((session) => !isConsult(session)) ?? recordedLive ?? live[0];
}

/**
 * The employee's live session on the Todo, if it has one.
 *
 * The row is the answer when its session is still live, unless it only
 * consulted while a live session of the same employee is working the Todo:
 * that one is adopted instead, so a mention reaches the work. Otherwise the
 * Todo's linked sessions are searched, newest first, and a live one is adopted
 * into the row: a session started before this table existed, or by a path that
 * links without consulting it, is still the employee's session on the Todo.
 */
export function liveEmployeeSession(workItemId: string, employee: string): Session | undefined {
  const record = getEmployeeSessionRecord(workItemId, employee);
  const recorded = record ? getSession(record.sessionId) : undefined;
  const recordedLive = isLiveEmployeeSession(recorded, workItemId, employee) ? recorded : undefined;
  if (recordedLive && !isConsult(recordedLive)) return recordedLive;
  const linked = adoptable(workItemId, employee, recordedLive);
  if (!linked) return undefined;
  if (linked === recordedLive) return recordedLive;
  return adopt(workItemId, employee, record?.sessionId ?? null, linked);
}

/** Take the row for `linked`; if another start took it first, its session. */
function adopt(workItemId: string, employee: string, expected: string | null, linked: Session): Session | undefined {
  if (swapEmployeeSession(workItemId, employee, expected, linked.id)) return linked;
  const winner = getEmployeeSessionRecord(workItemId, employee);
  const current = winner ? getSession(winner.sessionId) : undefined;
  return isLiveEmployeeSession(current, workItemId, employee) ? current : undefined;
}

/**
 * The employee's live session on the Todo, or a new one from `start`, decided as
 * one write: the look-up, the spawn and the swap run in a single immediate
 * transaction, so two starts for the same employee can never both spawn. A
 * `start` that throws rolls the whole decision back.
 */
export function resolveEmployeeSession(
  workItemId: string,
  employee: string,
  start: () => Session,
): { session: Session; started: boolean } {
  return employeeSessionsTable().transaction(() => {
    const live = liveEmployeeSession(workItemId, employee);
    if (live) return { session: live, started: false };
    const expected = getEmployeeSessionRecord(workItemId, employee)?.sessionId ?? null;
    const session = start();
    if (!swapEmployeeSession(workItemId, employee, expected, session.id)) {
      throw new Error(`Todo ${workItemId}: ${employee}'s session changed while a new one was being started`);
    }
    return { session, started: true };
  }).immediate();
}
