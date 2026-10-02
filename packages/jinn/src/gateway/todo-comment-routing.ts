import { logger } from "../shared/logger.js";
import type { Employee, Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { addComment, getComment, setTodoCommentListener, type WorkItemComment } from "../work-items/comments.js";
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
    + `Unless you are already working this Todo, you are being consulted, not handed the work: whoever holds it `
    + `keeps it unless it is delegated to you. Decide what the comment needs from you, and answer on the thread.`;
}

function replyPrompt(item: WorkItem, comment: WorkItemComment): string {
  return `💬 ${comment.author} replied to your comment on Todo ${item.id}, "${item.title}".\n\n`
    + `${comment.body}\n\n${threadHint(comment)} Reply only when the thread needs something from you: `
    + `an acknowledgement or thanks wakes the other side for nothing.`;
}

/** Replies between sessions on one Todo that are delivered before the thread
 *  stops passing them on. Two agents answering each other's answers would
 *  otherwise wake each other for ever. The operator's replies are not counted,
 *  and the cap holds for the life of the Todo. */
export const MAX_AGENT_REPLIES_PER_TODO = 20;

/** The session the comment answers, if a session wrote that comment and it can
 *  still be messaged. Never the author's own session or employee, and never a
 *  system employee's, which a mention cannot wake either. */
function answeredSession(comment: WorkItemComment, authorEmployee: string | undefined, roster: Roster): Session | undefined {
  const answered = comment.repliedToId ? getComment(comment.repliedToId) : undefined;
  const session = answered?.sessionId ? getSession(answered.sessionId) : undefined;
  if (!session || !canMessageSession(session) || session.id === comment.sessionId) return undefined;
  return answersItself(session, authorEmployee, roster) ? undefined : session;
}

function answersItself(session: Session, authorEmployee: string | undefined, roster: Roster): boolean {
  return !!session.employee && (session.employee === authorEmployee || !!roster.get(session.employee.toLowerCase())?.system);
}

type Roster = Map<string, Employee>;

/** The roster by lowercased name, so a mention matches whatever case the
 *  employee's file gives its name. */
function rosterByMention(context: ApiContext): Roster {
  return new Map([...orgRegistry(context.getConfig()).values()].map((employee) => [employee.name.toLowerCase(), employee]));
}


/** Say on the thread that a mention woke nobody, so its author is not left
 *  waiting on a reply that cannot come. A system reply is never routed. */
function reportFailedWake(comment: WorkItemComment, name: string, error: string): void {
  logger.warn(`Todo ${comment.workItemId}: could not wake @${name} for comment ${comment.id}: ${error}`);
  addComment({
    workItemId: comment.workItemId,
    parentCommentId: comment.id,
    author: "jinn",
    authorKind: "system",
    body: `**@${name} was not woken.** ${error}`,
    idempotencyKey: `mention-failed:${comment.id}:${name}`,
  });
}

function wakeOne(context: ApiContext, item: WorkItem, comment: WorkItemComment, employee: Employee): CommentWake | undefined {
  let woke: ReturnType<typeof wakeEmployeeOnTodo>;
  try {
    woke = wakeEmployeeOnTodo(context, {
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
  } catch (error) {
    woke = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (woke.ok) return { employee: employee.name, sessionId: woke.session.id, kind: "mention", started: woke.started };
  reportFailedWake(comment, employee.name, woke.error);
  return undefined;
}

function wakeMentioned(context: ApiContext, item: WorkItem, comment: WorkItemComment, authorEmployee: string | undefined, roster: Roster): CommentWake[] {
  const wakes: CommentWake[] = [];
  for (const name of parseMentions(comment.body)) {
    const employee = roster.get(name);
    if (!employee || employee.system || employee.name === authorEmployee) continue;
    const wake = wakeOne(context, item, comment, employee);
    if (wake) wakes.push(wake);
  }
  return wakes;
}

/** Deliver a reply into the session it answers. An agent's reply counts toward
 *  the Todo's cap; past it the thread says so instead of waking anyone. */
function deliverReply(item: WorkItem, comment: WorkItemComment, session: Session): boolean {
  const delivered = deliverIntoSession(session, {
    workItemId: item.id,
    sourceAttempt: `reply:${comment.id}`,
    deliveryKind: comment.authorKind === "employee" ? "todo-agent-reply" : "todo-reply",
    message: replyPrompt(item, comment),
    displayMessage: `💬 ${item.id} · ${comment.author}\n${comment.body}`,
  }, comment.authorKind === "employee" ? MAX_AGENT_REPLIES_PER_TODO : undefined);
  if (!delivered) {
    addComment({
      workItemId: item.id,
      parentCommentId: comment.id,
      author: "jinn",
      authorKind: "system",
      body: `**Reply not delivered.** Sessions on this Todo have already answered each other ${MAX_AGENT_REPLIES_PER_TODO} times, `
        + `which is the cap. Continue the conversation in their session, or ask the operator to step in.`,
      idempotencyKey: `reply-capped:${comment.id}`,
    });
  }
  return delivered;
}

export function routeTodoComment(context: ApiContext, comment: WorkItemComment): CommentWake[] {
  if (comment.authorKind === "system" || comment.deletedAt) return [];
  const item = getWorkItem(comment.workItemId);
  if (!item) return [];
  const authorEmployee = comment.authorKind === "employee" ? comment.author : undefined;
  const roster = rosterByMention(context);
  const wakes = wakeMentioned(context, item, comment, authorEmployee, roster);
  const answered = answeredSession(comment, authorEmployee, roster);
  if (answered && !wakes.some((wake) => wake.sessionId === answered.id) && deliverReply(item, comment, answered)) {
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
