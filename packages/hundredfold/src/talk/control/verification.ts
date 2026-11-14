import { getMessages, getSession, listSessionsByWorkItem } from "../../sessions/registry.js";
import { listComments } from "../../work-items/comments.js";
import { getWorkItem } from "../../work-items/store.js";
import { initDb } from "../../shared/db.js";
import { TalkTopicRepository } from "../topics/repository.js";
import type { TalkControlExecution, TalkControlOperation, TalkControlVerification } from "./types.js";
import { TALK_COMPANY_CAPABILITY_COVERAGE } from "./capability-coverage.js";

type VerifyHandler = (
  args: Record<string, unknown>,
  execution: TalkControlExecution,
) => TalkControlVerification;

function text(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

const verifyTodo: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  return { ok: !!item, evidence: item ? { id: item.id, version: item.version, status: item.status, assignee: item.assignee } : {} };
};

/** A dictated Todo is only created if the ledger has it, under the title that
 *  was spoken. The id comes from the execution, so a replay verifies the same
 *  row rather than a second one. */
const verifyCreate: VerifyHandler = (args, execution) => {
  const id = String((execution.data.todo as { id?: unknown } | undefined)?.id ?? "");
  const item = id ? getWorkItem(id) : undefined;
  return {
    ok: !!item && item.title === text(args, "title"),
    evidence: item ? { id: item.id, title: item.title, status: item.status, version: item.version } : {},
  };
};

/** The board is the authority on where a Todo sits, not the transition's return
 *  value: a bounded-loop rule can redirect the move to `escalated`, and a
 *  status that did not land must not be reported as one that did. */
const verifyStatus: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  return {
    ok: !!item && item.status === text(args, "status"),
    evidence: item ? { id: item.id, status: item.status, version: item.version } : {},
  };
};

const verifyEdit: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  const expectedVersion = Number(args.expectedVersion);
  const matches = !!item && [
    item.version === expectedVersion + 1,
    args.title === undefined || item.title === args.title,
    args.body === undefined || item.body === args.body,
    args.priority === undefined || item.priority === args.priority,
  ].every(Boolean);
  return { ok: matches, evidence: item ? { id: item.id, version: item.version, title: item.title, priority: item.priority } : {} };
};

const verifyAssignment: VerifyHandler = (args) => {
  const item = getWorkItem(text(args, "id"));
  return { ok: !!item && item.assignee === text(args, "assignee"), evidence: item ? { id: item.id, version: item.version, assignee: item.assignee } : {} };
};

const verifyComment: VerifyHandler = (args, execution) => {
  const id = text(args, "id");
  const commentId = String(execution.data.commentId ?? "");
  const comment = listComments(id, { limit: 500 }).comments.find((candidate) => candidate.id === commentId);
  return { ok: !!comment, evidence: comment ? { id: comment.id, workItemId: comment.workItemId } : {} };
};

const verifyDelegation: VerifyHandler = (args, execution) => {
  const id = text(args, "id");
  const sessionId = String(execution.data.sessionId ?? "");
  const linked = listSessionsByWorkItem(id).some((session) => session.id === sessionId);
  const session = getSession(sessionId);
  const employee = text(args, "employee");
  const item = getWorkItem(id);
  const ok = linked && !!session && session.employee === employee && item?.assignee === employee;
  return { ok, evidence: session ? { todoId: id, sessionId, employee: session.employee, status: session.status } : {} };
};

const verifySession: VerifyHandler = (args) => {
  const id = text(args, "id");
  const session = getSession(id);
  return { ok: !!session, evidence: session ? { sessionId: session.id, status: session.status, messages: getMessages(id).length } : {} };
};

const verifyMessage: VerifyHandler = (args, execution) => {
  const id = text(args, "id");
  const messageId = String(execution.data.messageId ?? "");
  const message = getMessages(id).find((candidate) => candidate.id === messageId);
  return { ok: !!message, evidence: message ? { sessionId: id, messageId } : {} };
};

const verifyTopicResolution: VerifyHandler = (_args, execution) => ({
  ok: ["resolved", "ambiguous", "none"].includes(String(execution.data.status)),
  evidence: { status: execution.data.status, topicId: (execution.data.topic as { id?: unknown } | undefined)?.id },
});

const verifyTopicCommitment: VerifyHandler = (_args, execution) => {
  const topicId = String((execution.data.topic as { id?: unknown } | undefined)?.id ?? "");
  const topic = new TalkTopicRepository(initDb()).get(topicId);
  return { ok: !!topic, evidence: topic ? { topicId: topic.id, revision: topic.revision } : {} };
};

const verifyCapability: VerifyHandler = (args, execution) => {
  const capability = text(args, "capability");
  const declared = TALK_COMPANY_CAPABILITY_COVERAGE[capability as keyof typeof TALK_COMPANY_CAPABILITY_COVERAGE];
  const status = String(execution.data.status ?? "");
  return {
    ok: declared ? status === declared.status : status === "unknown",
    evidence: declared ? { capability, status: declared.status } : { capability, status: "unknown" },
  };
};

const VERIFY_HANDLERS: Record<string, VerifyHandler> = {
  read_todo: verifyTodo,
  talk_create_todo: verifyCreate,
  talk_set_todo_status: verifyStatus,
  talk_edit_todo: verifyEdit,
  talk_assign_todo: verifyAssignment,
  talk_comment_todo: verifyComment,
  talk_delegate_todo: verifyDelegation,
  read_session: verifySession,
  talk_send_to_session: verifyMessage,
  talk_recall_topic: verifyTopicResolution,
  talk_remember_topic: verifyTopicCommitment,
  read_talk_capability: verifyCapability,
};

/** Every operation name with an authoritative re-read. A gateway operation
 *  missing from here fails closed (`ok: false`), which is correct but silent —
 *  the manifest suite asserts the pairing instead of waiting for it. */
export const VERIFY_HANDLER_NAMES: readonly string[] = Object.keys(VERIFY_HANDLERS);

export async function verifyTalkDomainOperation(
  operation: TalkControlOperation,
  args: Record<string, unknown>,
  execution: TalkControlExecution,
): Promise<TalkControlVerification> {
  const handler = VERIFY_HANDLERS[operation.name];
  return handler ? handler(args, execution) : { ok: false, evidence: {} };
}
