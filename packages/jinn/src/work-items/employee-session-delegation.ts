import type { Session } from '../shared/types.js';
import { employeeSessionsTable, getEmployeeSessionRecord, swapEmployeeSession, type EmployeeSessionRecord } from './employee-sessions.js';

/**
 * Who an employee's session on a Todo reports to, once delegations land in it.
 *
 * A delegation into a session somebody else started makes its delegator the one
 * the session reports to, but only from the turn the brief starts. The session
 * may be mid-turn on something else when the brief lands (answering the mention
 * that started it, say), and that turn's answer is not the delegation's report.
 * So a landing delegation is recorded as pending against the turn the session
 * was on, and takes over as soon as the session is on any other turn. Turns are
 * told apart by their attempt token, which every turn gets afresh.
 */

type ReportingSession = Pick<Session, 'id' | 'employee' | 'workItemId' | 'parentSessionId' | 'attemptToken'>;

/** The pending delegation has taken over: the session is on a later turn. */
function pendingIsCurrent(record: EmployeeSessionRecord, attemptToken: string | null | undefined): boolean {
  return record.pendingDelegatedAt !== null && (attemptToken ?? null) !== record.pendingAfterAttempt;
}

/** Who the session reports to by the record, or undefined when the record has
 *  no say (no delegation has landed, or it is not this session's row). */
function recordedDelegator(record: EmployeeSessionRecord | undefined, session: ReportingSession): string | null | undefined {
  if (!record || record.sessionId !== session.id) return undefined;
  if (pendingIsCurrent(record, session.attemptToken)) return record.pendingDelegatorSessionId;
  return record.delegatedAt ? record.delegatorSessionId : undefined;
}

/** The delegation in force on the session's current turn: a pending one that
 *  has taken over, or the one it already reported to. */
function effectiveDelegation(record: EmployeeSessionRecord, attemptToken: string | null | undefined): { delegator: string | null; at: string | null } {
  return pendingIsCurrent(record, attemptToken)
    ? { delegator: record.pendingDelegatorSessionId, at: record.pendingDelegatedAt }
    : { delegator: record.delegatorSessionId, at: record.delegatedAt };
}

/**
 * A delegation landed in the employee's session; it reports to
 * `delegatorSessionId` (null for the operator, who has no session to wake) from
 * the session's next turn on. `immediate` is for a session spawned for the
 * delegation, whose first turn is the brief. A delegation still pending when the
 * next lands has taken over if the session moved on, and is otherwise replaced.
 */
export function recordDelegation(
  workItemId: string,
  employee: string,
  session: Pick<Session, 'id' | 'attemptToken'>,
  delegatorSessionId: string | null,
  opts: { immediate?: boolean } = {},
): void {
  const db = employeeSessionsTable();
  db.transaction(() => {
    const record = getEmployeeSessionRecord(workItemId, employee);
    if (!record || record.sessionId !== session.id) return;
    const now = new Date().toISOString();
    const landed = { delegator: delegatorSessionId, at: now };
    const effective = opts.immediate ? landed : effectiveDelegation(record, session.attemptToken);
    const pending = opts.immediate ? { delegator: null, at: null, after: null } : { ...landed, after: session.attemptToken ?? null };
    db.prepare(
      `UPDATE work_item_employee_sessions SET delegator_session_id = ?, delegated_at = ?,
         pending_delegator_session_id = ?, pending_delegated_at = ?, pending_after_attempt = ?, updated_at = ?
       WHERE work_item_id = ? AND employee = ? AND session_id = ?`,
    ).run(effective.delegator, effective.at, pending.delegator, pending.at, pending.after, now, workItemId, employee, session.id);
  })();
}

/** A delegation spawned a new session for the employee: it is now their
 *  session on the Todo, replacing a dead one, and reports to this delegator. */
export function recordNewDelegateSession(workItemId: string, employee: string, session: Pick<Session, 'id' | 'attemptToken'>, delegatorSessionId: string | undefined): void {
  const expected = getEmployeeSessionRecord(workItemId, employee)?.sessionId ?? null;
  if (swapEmployeeSession(workItemId, employee, expected, session.id)) {
    recordDelegation(workItemId, employee, session, delegatorSessionId ?? null, { immediate: true });
  }
}

/**
 * The session a child's callbacks go to: the delegator of the last delegation
 * whose turn has started, when it is the employee's session on its Todo and one
 * has; otherwise its own parent. Null means nobody is waiting on it. Never the
 * session itself: a session that delegated its own Todo to its own employee has
 * nobody to report to but whoever it reported to before.
 */
export function reportingParentSessionId(session: ReportingSession): string | null {
  const own = session.parentSessionId === session.id ? null : session.parentSessionId ?? null;
  if (!session.workItemId || !session.employee) return own;
  const delegator = recordedDelegator(getEmployeeSessionRecord(session.workItemId, session.employee), session);
  if (delegator === undefined || delegator === session.id) return own;
  return delegator;
}

/** The same session with its callbacks pointed where they now go. */
export function withReportingParent<T extends ReportingSession>(session: T): T {
  const parentSessionId = reportingParentSessionId(session);
  return parentSessionId === (session.parentSessionId ?? null) ? session : { ...session, parentSessionId };
}
