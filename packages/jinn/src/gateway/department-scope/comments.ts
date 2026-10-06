import { getSession } from "../../sessions/registry.js";
import type { Employee, Session } from "../../shared/types.js";
import type { WorkItemComment } from "../../work-items/comments.js";

/**
 * A comment can wake an employee (an `@mention`) or deliver into another session (a
 * reply), which is a spawn and a send by other means. From a department-scoped
 * session they follow the same rules as `spawn_session` and `send_to_session`
 * (FR-012, FR-013, FR-016): a mention wakes only its department's members, and a reply
 * reaches only a session bound to its department or the session that asked it for work.
 */

function authorDepartment(comment: WorkItemComment): { department: string; author: Session } | null {
  const author = comment.sessionId ? getSession(comment.sessionId) : undefined;
  return author?.scopeDepartment ? { department: author.scopeDepartment, author } : null;
}

/** Why a scoped author's mention may not wake `employee`, or null. */
export function scopedMentionRefusal(comment: WorkItemComment, employee: Employee): string | null {
  const scoped = authorDepartment(comment);
  if (!scoped || employee.department === scoped.department) return null;
  return `a session scoped to department "${scoped.department}" can only wake that department's members.`;
}

/** Whether a reply in `comment` may be delivered into `session`. */
export function scopedReplyAllowed(comment: WorkItemComment, session: Session): boolean {
  const scoped = authorDepartment(comment);
  return !scoped || session.scopeDepartment === scoped.department || session.id === scoped.author.parentSessionId;
}
