import type { Session } from '../shared/types.js';
import { getSession, listSessionsByWorkItem } from '../sessions/registry.js';
import { isLegacyWorkflowPhaseSession } from '../sessions/legacy-workflow-phase.js';
import { canMessageSession, employeeSessionsTable, isLiveEmployeeSession } from './employee-sessions.js';
import { toWorkItemLinkRole } from './link-role.js';
import type { WorkItem } from './store.js';

/**
 * The session through which an employee owns a Todo from outside it.
 *
 * A session that delegates a Todo, or creates one, stays on its own Todo (or
 * none): a session links to one Todo only. So the employee's sessions linked to
 * the Todo leave out the one that holds its design and waits for its result,
 * and a mention of that employee would otherwise start a consultation with
 * none of that context, one that can contradict the owner within a minute.
 *
 * An employee with a live session working the Todo from inside (linked to
 * execute or review it) owns it there instead: that session holds the latest
 * state of the work, whoever created or delegated it, and the ordinary
 * look-up finds it. Otherwise, looked for in this order, and only that
 * employee's sessions that can still be messaged count:
 * - the delegator each employee's session on the Todo reports to, the most
 *   recent delegation first;
 * - the parent of each session linked to the Todo, newest first, which is who
 *   started it by delegation;
 * - the session that created the Todo, by `create_work_item` or `delegate_task`.
 */

/** Delegators recorded against the Todo's employee sessions, newest first. */
function recordedDelegators(workItemId: string): string[] {
  return employeeSessionsTable()
    .prepare(`SELECT delegator_session_id FROM work_item_employee_sessions
      WHERE work_item_id = ? AND delegator_session_id IS NOT NULL ORDER BY delegated_at DESC`)
    .pluck()
    .all(workItemId) as string[];
}

/** The session id in a session- or delegation-created Todo's source ref. */
function creatorSessionId(item: WorkItem): string | undefined {
  return /^(?:session|delegate):([^:]+):/.exec(item.sourceRef ?? '')?.[1];
}

function candidateIds(item: WorkItem): string[] {
  const parents = listSessionsByWorkItem(item.id).map((session) => session.parentSessionId);
  return [...recordedDelegators(item.id), ...parents, creatorSessionId(item)].filter((id): id is string => !!id);
}

/** Whether `employee` has a live session linked to work the Todo, not just consulted on it. */
function worksItFromInside(item: WorkItem, employee: string): boolean {
  return listSessionsByWorkItem(item.id).some((session) =>
    isLiveEmployeeSession(session, item.id, employee) && toWorkItemLinkRole(session.workItemRole) !== 'consult');
}

/** `employee`'s live delegating or creating session for `item`, if any, unless
 *  one of theirs works it from inside. */
export function owningEmployeeSession(item: WorkItem, employee: string): Session | undefined {
  if (worksItFromInside(item, employee)) return undefined;
  for (const id of new Set(candidateIds(item))) {
    const session = getSession(id);
    if (session?.employee === employee && canMessageSession(session) && !isLegacyWorkflowPhaseSession(session)) return session;
  }
  return undefined;
}
