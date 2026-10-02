import type { Database as DatabaseType } from 'better-sqlite3';
import type { Session } from '../shared/types.js';
import { getSession } from '../sessions/registry.js';
import { employeeSessionsTable, getEmployeeSessionRecord, swapEmployeeSession } from './employee-sessions.js';

/**
 * Who an employee's session on a Todo reports to, once delegations land in it.
 *
 * A delegation into a session somebody else started makes its delegator the one
 * the session reports to, but only from the turn that runs its brief. The
 * session may run other turns before then: the one it was on when the brief
 * landed, a mention or reply queued ahead of the brief. Their answers are not
 * the delegation's report. So a landing brief is recorded under its own key,
 * waiting, and the turn that runs it (`startBriefTurn`) is the moment its
 * delegator takes over.
 */

type ReportingSession = Pick<Session, 'id' | 'employee' | 'workItemId' | 'parentSessionId'>;

const ready = new WeakSet<DatabaseType>();

/** Briefs that have landed in a live session and whose turn has not started. */
function briefsTable(): DatabaseType {
  const db = employeeSessionsTable();
  if (ready.has(db)) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS work_item_delegation_briefs (
    brief_key            TEXT PRIMARY KEY,
    work_item_id         TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    employee             TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    delegator_session_id TEXT,
    created_at           TEXT NOT NULL
  )`);
  ready.add(db);
  return db;
}

/** The session now reports to `delegatorSessionId` (null for the operator, who
 *  has no session to wake), if it is still the employee's session on the Todo. */
function recordDelegator(workItemId: string, employee: string, sessionId: string, delegatorSessionId: string | null): void {
  const now = new Date().toISOString();
  employeeSessionsTable().prepare(
    `UPDATE work_item_employee_sessions SET delegator_session_id = ?, delegated_at = ?, updated_at = ?
      WHERE work_item_id = ? AND employee = ? AND session_id = ?`,
  ).run(delegatorSessionId, now, now, workItemId, employee, sessionId);
}

/** A delegation spawned a new session for the employee: it is now their
 *  session on the Todo, replacing a dead one, and its first turn is the brief. */
export function recordNewDelegateSession(workItemId: string, employee: string, sessionId: string, delegatorSessionId: string | undefined): void {
  const expected = getEmployeeSessionRecord(workItemId, employee)?.sessionId ?? null;
  if (swapEmployeeSession(workItemId, employee, expected, sessionId)) {
    recordDelegator(workItemId, employee, sessionId, delegatorSessionId ?? null);
  }
}

export interface LandedBrief {
  /** What the turn that runs the brief is recognised by: its outbox delivery's
   *  source attempt, or `queue:<id>` for a brief queued directly. */
  briefKey: string;
  workItemId: string;
  employee: string;
  sessionId: string;
  delegatorSessionId: string | null;
}

interface BriefRow {
  brief_key: string;
  work_item_id: string;
  employee: string;
  session_id: string;
  delegator_session_id: string | null;
}

/** A brief landed in a live session; its delegator waits for its turn. */
export function recordLandedBrief(brief: LandedBrief): void {
  briefsTable().prepare(
    `INSERT INTO work_item_delegation_briefs (brief_key, work_item_id, employee, session_id, delegator_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(brief_key) DO UPDATE SET delegator_session_id = excluded.delegator_session_id`,
  ).run(brief.briefKey, brief.workItemId, brief.employee, brief.sessionId, brief.delegatorSessionId, new Date().toISOString());
}

/**
 * The turn starting in `sessionId` runs one of these briefs: its delegator now
 * takes over, and the brief is spent. Returns the brief, or undefined when the
 * turn runs none.
 */
export function startBriefTurn(sessionId: string, briefKeys: string[]): LandedBrief | undefined {
  if (briefKeys.length === 0) return undefined;
  const db = briefsTable();
  return db.transaction((): LandedBrief | undefined => {
    const row = db.prepare(
      `SELECT * FROM work_item_delegation_briefs WHERE session_id = ? AND brief_key IN (${briefKeys.map(() => '?').join(', ')}) LIMIT 1`,
    ).get(sessionId, ...briefKeys) as BriefRow | undefined;
    if (!row) return undefined;
    db.prepare('DELETE FROM work_item_delegation_briefs WHERE brief_key = ?').run(row.brief_key);
    recordDelegator(row.work_item_id, row.employee, sessionId, row.delegator_session_id);
    return { briefKey: row.brief_key, workItemId: row.work_item_id, employee: row.employee, sessionId, delegatorSessionId: row.delegator_session_id };
  })();
}

/** One hop: the recorded delegator, when the record has a say, else the parent. */
function recordedHop(session: ReportingSession): { to: string | null; recorded: boolean } {
  if (session.workItemId && session.employee) {
    const record = getEmployeeSessionRecord(session.workItemId, session.employee);
    if (record?.sessionId === session.id && record.delegatedAt) return { to: record.delegatorSessionId, recorded: true };
  }
  return { to: session.parentSessionId ?? null, recorded: false };
}

/** Everyone `sessionId` reports to or will: its recorded delegator or parent,
 *  and the delegator of every brief waiting to start in it. */
function reportsToNow(sessionId: string): string[] {
  const session = getSession(sessionId);
  const waiting = briefsTable().prepare('SELECT delegator_session_id FROM work_item_delegation_briefs WHERE session_id = ?')
    .pluck().all(sessionId) as Array<string | null>;
  return [session ? recordedHop(session).to : null, ...waiting].filter((id): id is string => !!id);
}

/** Whether following who reports to whom from `start`, counting briefs that
 *  have landed but not started, reaches `target`. */
export function reportsUpTo(start: string | null | undefined, target: string): boolean {
  const seen = new Set<string>();
  const pending = start ? [start] : [];
  for (let current = pending.pop(); current; current = pending.pop()) {
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...reportsToNow(current));
  }
  return false;
}

/**
 * The session a child's callbacks go to: the delegator of the last delegation
 * whose brief has started, when it is the employee's session on its Todo;
 * otherwise its own parent. Null means nobody is waiting on it. Never the
 * session itself or anything that reports back up to it: a delegation that
 * would close a loop is refused when it lands, and a record that closes one
 * anyway is passed over for the session's own parent.
 */
export function reportingParentSessionId(session: ReportingSession): string | null {
  const own = session.parentSessionId === session.id ? null : session.parentSessionId ?? null;
  const hop = recordedHop(session);
  if (!hop.recorded) return own;
  return hop.to && reportsUpTo(hop.to, session.id) ? own : hop.to;
}

/** The same session with its callbacks pointed where they now go. */
export function withReportingParent<T extends ReportingSession>(session: T): T {
  const parentSessionId = reportingParentSessionId(session);
  return parentSessionId === (session.parentSessionId ?? null) ? session : { ...session, parentSessionId };
}
