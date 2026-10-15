import type { Session } from '../shared/types.js';
import { getSession, listSessionsByWorkItem } from '../sessions/registry.js';
import { isLegacyWorkflowPhaseSession } from '../sessions/legacy-workflow-phase.js';
import { canMessageSession, employeeSessionsTable } from './employee-sessions.js';
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
 * Looked for in this order, and only that employee's sessions that can still be
 * messaged count:
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

/** `employee`'s live delegating or creating session for `item`, if any. */
export function owningEmployeeSession(item: WorkItem, employee: string): Session | undefined {
  for (const id of new Set(candidateIds(item))) {
    const session = getSession(id);
    if (session?.employee === employee && canMessageSession(session) && !isLegacyWorkflowPhaseSession(session)) return session;
  }
  return undefined;
}
