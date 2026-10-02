import { initDb } from '../shared/db.js';
import type { WriteOrigin } from './origin.js';
import {
  appendWorkItemEvent,
  ensureDepartmentRegistered,
  getWorkItem,
  releaseSelfStartedLinks,
  resolveTodoDepartments,
  STICKY_STATUSES,
  type AppendWorkItemEventInput,
  type WorkItem,
} from './store.js';
import { todoProvenanceSnapshot, TransitionError, type TransitionResult } from './transitions.js';

/**
 * Assignment: granting ownership. It answers who owns a Todo, never where it
 * sits — the Todo keeps its status, and assigning one starts nothing (a dispatch
 * does). It borrows `transitions.ts`'s audit shape and its live listener rather
 * than inventing a second one. The ownership fields on their own stay separately
 * restorable by the operator pen.
 */

export { OPERATOR_ASSIGNEE } from './operator-assignee.js';

interface Assignment {
  assignee: string;
  department: string | null;
  actor?: string | null;
  /** The employee behind a `session:` actor, when the caller knows it. */
  actorEmployee?: string;
  origin?: WriteOrigin;
  /** Self-started sessions the reassignment took off the Todo. */
  releasedSessions?: string[];
}

/** Assignment leaves the Todo where it sits, so its audit row is a `note`, not
 *  a status change. */
function assignmentEvent(
  item: WorkItem,
  { assignee, department, actor, actorEmployee, origin, releasedSessions = [] }: Assignment,
): AppendWorkItemEventInput {
  return {
    workItemId: item.id,
    kind: 'note',
    fromStatus: null,
    toStatus: null,
    actor: actor ?? null,
    detail: {
      assignee,
      department,
      ...(actorEmployee ? { actorEmployee } : {}),
      ...(origin ? { origin } : {}),
      ...(releasedSessions.length > 0 ? { releasedSessions } : {}),
      todoProvenance: todoProvenanceSnapshot({ source: item.source, department, assignee }),
    },
    versionEffect: 'companion',
  };
}

/** Assign a Todo to an employee, or to the operator. Sole owner of assignment: the assign route
 * and delegation are its only callers and carry the roster check. The operator pen instead restores
 * or clears the ownership fields, version-fenced, with no notification. */
export interface AssignWorkItemOptions {
  origin?: WriteOrigin;
  /** The employee behind a `session:` actor, when the caller knows it. */
  actorEmployee?: string;
}

/** With open departments a Todo follows its assignee's org department. Under
 *  `gateway.todoDepartments` (JIN-1) the department is a classification, so
 *  assignment keeps it and only fills an empty one with the configured default. */
function departmentAfterAssignment(current: string | null, assigneeDepartment: string | null): string | null {
  const policy = resolveTodoDepartments();
  return policy ? current ?? policy.defaultDepartment : assigneeDepartment;
}

export function assignWorkItem(
  id: string,
  assignee: string,
  assigneeDepartment: string | null,
  actor?: string | null,
  { origin, actorEmployee }: AssignWorkItemOptions = {},
): WorkItem | undefined {
  const db = initDb();
  const txn = db.transaction((): TransitionResult | undefined => {
    const item = getWorkItem(id);
    if (!item) return undefined;
    if (STICKY_STATUSES.has(item.status)) {
      throw new TransitionError('illegal-edge', `cannot assign work item ${id} while it is in terminal state ${item.status}`);
    }
    const department = departmentAfterAssignment(item.department, assigneeDepartment);
    if (item.assignee === assignee && item.department === department) {
      return { item, escalated: false };
    }
    if (department !== null) ensureDepartmentRegistered(department); // review F2: same-transaction registry mint
    const now = new Date().toISOString();
    const result = db
      .prepare('UPDATE work_items SET assignee = ?, department = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ?')
      .run(assignee, department, now, id, item.status);
    if (result.changes === 0) {
      throw new TransitionError('conflict', `work item ${id} changed concurrently (expected status ${item.status})`);
    }
    // A chat that started this Todo for its own employee stops being its
    // executor once the Todo is somebody else's: left linked, its turns would
    // keep the new owner's dispatch refused and keep deriving the Todo's status.
    const releasedSessions = releaseSelfStartedLinks(db, id, { exceptEmployee: assignee });
    const event = appendWorkItemEvent(assignmentEvent(item, { assignee, department, actor, actorEmployee, origin, releasedSessions }));
    return { item: getWorkItem(id)!, escalated: false, event };
  });
  return txn()?.item;
}
