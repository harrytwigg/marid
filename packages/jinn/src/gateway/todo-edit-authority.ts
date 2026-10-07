/**
 * Who may edit which field of a Todo through the metadata pen, and what a
 * refusal tells them.
 */

import type { UpdateWorkItemInput } from '../work-items/store.js';
import { workItemActor, type WorkItemCaller } from './work-item-arming.js';

/** What a Todo SAYS: open to every authenticated session, like its status. */
const TODO_CONTENT_FIELDS: ReadonlyArray<keyof UpdateWorkItemInput> = ['title', 'body', 'priority', 'dueAt', 'startAt'];

/** Who a Todo BELONGS to: the operator's alone. */
const TODO_OWNERSHIP_FIELDS: ReadonlyArray<keyof UpdateWorkItemInput> = ['assignee', 'department', 'rank'];

export interface TodoEditAuthority {
  fields: ReadonlySet<keyof UpdateWorkItemInput>;
  actor: string;
  who: string;
}

/**
 * Resolve the per-field edit authority, split on content versus ownership.
 *
 * Content is open for the same reason status is: gating it on a relation to the
 * Todo (creator / assignee / assignee's manager / bound workflow run) bought
 * nothing and cost honesty. A participant that could do the work could not
 * record what the work now says, and had to ask someone with standing to
 * perform the write for it. Every new kind of participant needed its own
 * relation and its own 403 before it could describe its own Todo.
 *
 * Ownership stays operator-only, and deliberately: assignee, department, and
 * rank decide who is accountable. Those are governance, not description, and an
 * agent reassigning its own work is exactly what the review model exists to
 * prevent.
 */
export function resolveTodoEditAuthority(caller: WorkItemCaller): TodoEditAuthority {
  if (caller.kind === 'operator') {
    return {
      fields: new Set<keyof UpdateWorkItemInput>([...TODO_CONTENT_FIELDS, ...TODO_OWNERSHIP_FIELDS]),
      actor: 'operator',
      who: 'the operator',
    };
  }
  const employee = caller.session.employee;
  return {
    fields: new Set<keyof UpdateWorkItemInput>(TODO_CONTENT_FIELDS),
    actor: employee ?? workItemActor(caller),
    who: employee ? `employee "${employee}"` : `session ${caller.callerId}`,
  };
}

/** Why a field was refused, naming what this caller may set instead. */
export function todoEditRefusal(field: keyof UpdateWorkItemInput, who: string): string {
  return `field "${field}" is not editable by ${who}: ${TODO_OWNERSHIP_FIELDS.join(', ')} are operator-only`;
}
