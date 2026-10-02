import type { Database as DatabaseType } from 'better-sqlite3';
import { initDb } from '../shared/db.js';
import type { Session } from '../shared/types.js';
import { getSession, listSessionsByWorkItem } from '../sessions/registry.js';
import { isLegacyWorkflowPhaseSession } from '../sessions/legacy-workflow-phase.js';
import { isTerminalSession } from '../terminals/session.js';

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
 * reports to from then on (`reportingParentSessionId`); the session's own
 * parent is left as it was, and is not woken.
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

function table(): DatabaseType {
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
  const row = table()
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
  return table().prepare(
    `INSERT INTO work_item_employee_sessions (work_item_id, employee, session_id, delegator_session_id, delegated_at, updated_at)
     VALUES (:workItemId, :employee, :sessionId, NULL, NULL, :now)
     ON CONFLICT(work_item_id, employee) DO UPDATE SET
       session_id = excluded.session_id, delegator_session_id = NULL, delegated_at = NULL, updated_at = excluded.updated_at
     WHERE work_item_employee_sessions.session_id = :expected`,
  ).run({ workItemId, employee, sessionId, expected, now: new Date().toISOString() }).changes === 1;
}

/**
 * The employee's live session on the Todo, if it has one.
 *
 * The row is the answer when its session is still live. Otherwise the Todo's
 * linked sessions are searched, newest first, and a live one is adopted into the
 * row: a session started before this table existed, or by a path that links
 * without starting (cron, Talk), is still the employee's session on the Todo.
 */
export function liveEmployeeSession(workItemId: string, employee: string): Session | undefined {
  const record = getEmployeeSessionRecord(workItemId, employee);
  const recorded = record ? getSession(record.sessionId) : undefined;
  if (isLiveEmployeeSession(recorded, workItemId, employee)) return recorded;
  const linked = listSessionsByWorkItem(workItemId).find((session) => isLiveEmployeeSession(session, workItemId, employee));
  if (!linked) return undefined;
  if (swapEmployeeSession(workItemId, employee, record?.sessionId ?? null, linked.id)) return linked;
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
  return table().transaction(() => {
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

/** A delegation landed in the employee's session: from now on it reports to
 *  `delegatorSessionId` (null for the operator, who has no session to wake). */
export function recordDelegation(workItemId: string, employee: string, sessionId: string, delegatorSessionId: string | null): void {
  const now = new Date().toISOString();
  table().prepare(
    `UPDATE work_item_employee_sessions SET delegator_session_id = ?, delegated_at = ?, updated_at = ?
      WHERE work_item_id = ? AND employee = ? AND session_id = ?`,
  ).run(delegatorSessionId, now, now, workItemId, employee, sessionId);
}

/**
 * The session a child's callbacks go to: the delegator of the last delegation
 * that landed in it, when it is the employee's session on its Todo and one has;
 * otherwise its own parent. Null means nobody is waiting on it.
 */
export function reportingParentSessionId(
  session: Pick<Session, 'id' | 'employee' | 'workItemId' | 'parentSessionId'>,
): string | null {
  if (session.workItemId && session.employee) {
    const record = getEmployeeSessionRecord(session.workItemId, session.employee);
    if (record?.sessionId === session.id && record.delegatedAt) return record.delegatorSessionId;
  }
  return session.parentSessionId ?? null;
}

/** The same session with its callbacks pointed where they now go. */
export function withReportingParent<T extends Pick<Session, 'id' | 'employee' | 'workItemId' | 'parentSessionId'>>(session: T): T {
  const parentSessionId = reportingParentSessionId(session);
  return parentSessionId === (session.parentSessionId ?? null) ? session : { ...session, parentSessionId };
}

/** A delegation spawned a new session for the employee: it is now their
 *  session on the Todo, replacing a dead one, and reports to this delegator. */
export function recordNewDelegateSession(workItemId: string, employee: string, sessionId: string, delegatorSessionId: string | undefined): void {
  const expected = getEmployeeSessionRecord(workItemId, employee)?.sessionId ?? null;
  if (swapEmployeeSession(workItemId, employee, expected, sessionId)) {
    recordDelegation(workItemId, employee, sessionId, delegatorSessionId ?? null);
  }
}
