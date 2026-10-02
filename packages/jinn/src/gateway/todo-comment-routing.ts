import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { getComment, setTodoCommentListener, type WorkItemComment } from "../work-items/comments.js";
import { canMessageSession } from "../work-items/employee-sessions.js";
import { parseMentions } from "../work-items/mentions.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { orgRegistry } from "./org-registry.js";
import { deliverIntoSession, wakeEmployeeOnTodo } from "./todo-employee-session.js";
import type { ApiContext } from "./api.js";

/**
 * Who a new comment on a Todo wakes.
 *
 * - Each `@employee` it mentions, on this Todo: into the session that employee
 *   already has on it, or a new one linked as a consultation. A mention never
 *   takes the Todo's claim, so the employee doing the work keeps it.
 * - When it replies to a comment a session wrote, that session, even when the
 *   reply was stored flattened against an operator-authored thread root: the
 *   comment it actually answered is in its meta.
 * - Nobody else. A comment that mentions no one and answers no session is
 *   recorded only.
 *
 * Nobody is woken by their own comment. Every delivery goes through the durable
 * outbox keyed on the comment, so one comment reaches each session once however
 * often this runs.
 */

export interface CommentWake {
  employee: string | null;
  sessionId: string;
  kind: "mention" | "reply";
  /** A new session was started for a mention, rather than delivered into. */
  started: boolean;
}

function threadHint(comment: WorkItemComment): string {
  return `Reply on the thread with comment_work_item { id: "${comment.workItemId}", body: "<reply>", `
    + `parentCommentId: "${comment.id}" }. Mention @<employee> in a comment to bring someone else in.`;
}

function mentionPrompt(item: WorkItem, comment: WorkItemComment): string {
  return `🏷️ You were tagged in this comment on Todo ${item.id}, "${item.title}" (/todos/${item.id}).\n\n`
    + `${comment.author} wrote:\n${comment.body}\n\n`
    + `Read the Todo with get_work_item { id: "${item.id}" } and its thread with list_work_item_comments { id: "${item.id}" }. `
    + `${threadHint(comment)}\n\n`
    + `You were consulted, not handed the work: whoever holds the Todo keeps it unless it is delegated to you. `
    + `Decide what the comment needs from you, and answer on the thread.`;
}

function replyPrompt(item: WorkItem, comment: WorkItemComment): string {
  return `💬 ${comment.author} replied to your comment on Todo ${item.id}, "${item.title}".\n\n`
    + `${comment.body}\n\n${threadHint(comment)}`;
}

/** The session the comment answers, if a session wrote that comment and it can
 *  still be messaged. Never the author's own session or employee. */
function answeredSession(comment: WorkItemComment, authorEmployee: string | undefined): Session | undefined {
  const answered = comment.repliedToId ? getComment(comment.repliedToId) : undefined;
  const session = answered?.sessionId ? getSession(answered.sessionId) : undefined;
  if (!session || !canMessageSession(session) || session.id === comment.sessionId) return undefined;
  return session.employee && session.employee === authorEmployee ? undefined : session;
}


function wakeMentioned(context: ApiContext, item: WorkItem, comment: WorkItemComment, authorEmployee: string | undefined): CommentWake[] {
  const roster = orgRegistry(context.getConfig());
  const wakes: CommentWake[] = [];
  for (const name of parseMentions(comment.body)) {
    const employee = roster.get(name);
    if (!employee || employee.system || name === authorEmployee) continue;
    const woke = wakeEmployeeOnTodo(context, {
      workItemId: item.id,
      employee,
      role: "consult",
      actor: comment.sessionId ? `session:${comment.sessionId}` : comment.author,
      title: `Tagged on ${item.id}: ${item.title}`,
      sourceAttempt: `mention:${comment.id}`,
      deliveryKind: "todo-mention",
      message: mentionPrompt(item, comment),
      displayMessage: `🏷️ ${item.id} · ${comment.author}\n${comment.body}`,
    });
    if (woke.ok) wakes.push({ employee: name, sessionId: woke.session.id, kind: "mention", started: woke.started });
    else logger.warn(`Todo ${item.id}: could not wake @${name} for comment ${comment.id}: ${woke.error}`);
  }
  return wakes;
}

export function routeTodoComment(context: ApiContext, comment: WorkItemComment): CommentWake[] {
  if (comment.authorKind === "system" || comment.deletedAt) return [];
  const item = getWorkItem(comment.workItemId);
  if (!item) return [];
  const authorEmployee = comment.authorKind === "employee" ? comment.author : undefined;
  const wakes = wakeMentioned(context, item, comment, authorEmployee);
  const answered = answeredSession(comment, authorEmployee);
  if (answered && !wakes.some((wake) => wake.sessionId === answered.id)) {
    deliverIntoSession(answered, {
      workItemId: item.id,
      sourceAttempt: `reply:${comment.id}`,
      deliveryKind: "todo-reply",
      message: replyPrompt(item, comment),
      displayMessage: `💬 ${item.id} · ${comment.author}\n${comment.body}`,
    });
    wakes.push({ employee: answered.employee ?? null, sessionId: answered.id, kind: "reply", started: false });
  }
  return wakes;
}

/** Route every comment the gateway records, whichever path wrote it: the
 *  comment route, a review handoff's note, the coordinator's reason, Talk. */
export function installTodoCommentRouting(context: ApiContext): () => void {
  setTodoCommentListener((comment) => {
    try {
      routeTodoComment(context, comment);
    } catch (error) {
      logger.warn(`Todo ${comment.workItemId}: routing comment ${comment.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return () => setTodoCommentListener(null);
}
