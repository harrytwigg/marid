import { checkAssignee } from "../../gateway/todo-assignee.js";
import { orgRegistry } from "../../gateway/org-registry.js";
import { getMessages, getSession } from "../../sessions/registry.js";
import { getWorkItem } from "../../work-items/store.js";
import { TalkControlRuntime } from "./runtime.js";
import { initDb } from "../../shared/db.js";
import { TalkTopicLifecycle } from "../topics/lifecycle.js";
import { TalkTopicRepository } from "../topics/repository.js";
import { requiredText, type DomainHandler, type TalkControlHost } from "./domain-types.js";
import { TODO_DOMAIN_HANDLERS } from "./todo-adapters.js";
import type {
  TalkControlAdapterContext,
  TalkControlExecution,
  TalkControlManifest,
  TalkControlOperation,
} from "./types.js";
import { verifyTalkDomainOperation } from "./verification.js";
import { dispatchTalkSessionMessage } from "./session-message-adapter.js";
import { delegateTodoWithTalk } from "./delegation-adapter.js";
import { TALK_COMPANY_CAPABILITY_COVERAGE } from "./capability-coverage.js";

export type { TalkControlHost } from "./domain-types.js";

function sessionData(id: string): Record<string, unknown> {
  const session = getSession(id);
  if (!session) throw new Error(`Session ${id} not found`);
  return {
    id: session.id,
    employee: session.employee,
    engine: session.engine,
    status: session.status,
    title: session.title,
    messages: getMessages(id).slice(-8).map((message) => ({ id: message.id, role: message.role, content: message.content })),
  };
}

function delegateTodo(host: TalkControlHost, args: Record<string, unknown>, call: TalkControlAdapterContext): TalkControlExecution {
  const id = requiredText(args, "id");
  const employeeName = requiredText(args, "employee");
  const item = getWorkItem(id);
  if (!item) throw new Error(`Todo ${id} not found`);
  const checked = checkAssignee(orgRegistry(host.context.getConfig()), employeeName, { operator: false });
  if (!checked.ok) throw new Error(checked.error);
  const employee = checked.employee!;
  const prompt = typeof args.task === "string" && args.task.trim()
    ? args.task.trim()
    : [item.title, item.body].filter(Boolean).join("\n\n");
  return delegateTodoWithTalk({
    context: host.context,
    sourceSessionId: host.sourceSessionId,
    todoId: id,
    prompt,
    employee: {
      name: employee.name,
      department: employee.department ?? null,
      engine: employee.engine,
      model: employee.model,
      effortLevel: employee.effortLevel,
    },
    call,
  });
}

const sendToSession: DomainHandler = (host, args, call) => {
  const id = requiredText(args, "id");
  const sent = dispatchTalkSessionMessage(host.context, id, requiredText(args, "message"), call);
  return { data: { sessionId: id, ...sent }, uiEffect: { invalidate: ["sessions", `session:${id}`], navigate: `/?session=${encodeURIComponent(id)}` } };
};

const recallTopic: DomainHandler = (_host, args, call) => {
  const result = new TalkTopicLifecycle(new TalkTopicRepository(initDb())).resolve(
    call.talkSessionId,
    requiredText(args, "reference"),
  );
  if (result.status === "none") return { data: result, uiEffect: null };
  if (result.status === "ambiguous") {
    return { data: { ...result, candidates: result.candidates.map(({ id, label, kind }) => ({ id, label, kind })) }, uiEffect: null };
  }
  const route = result.topic.retrievalAnchors.find((anchor) => anchor.startsWith("route:"))?.slice(6);
  return {
    data: { status: result.status, reason: result.reason, confidence: result.confidence, topic: result.topic },
    uiEffect: route ? { navigate: route } : null,
  };
};

const rememberTopic: DomainHandler = (_host, args, call) => {
  const fields = ["goal", "decision", "unresolvedQuestion", "resolvedQuestion"] as const;
  if (!fields.some((field) => typeof args[field] === "string" && args[field].trim())) {
    throw new Error("A goal, decision, unresolved question, or resolved question is required");
  }
  const topic = new TalkTopicLifecycle(new TalkTopicRepository(initDb())).remember(call.talkSessionId, {
    ...(typeof args.topicId === "string" ? { topicId: args.topicId } : {}),
    ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
    ...(typeof args.decision === "string" ? { decision: args.decision } : {}),
    ...(typeof args.unresolvedQuestion === "string" ? { unresolvedQuestion: args.unresolvedQuestion } : {}),
    ...(typeof args.resolvedQuestion === "string" ? { resolvedQuestion: args.resolvedQuestion } : {}),
  });
  return { data: { topic }, uiEffect: null };
};

const readCapability: DomainHandler = (_host, args) => {
  const capability = requiredText(args, "capability");
  const coverage = TALK_COMPANY_CAPABILITY_COVERAGE[capability as keyof typeof TALK_COMPANY_CAPABILITY_COVERAGE];
  if (!coverage) {
    return {
      data: { status: "unknown", capability, knownCapabilities: Object.keys(TALK_COMPANY_CAPABILITY_COVERAGE) },
      uiEffect: null,
    };
  }
  return { data: { capability, ...coverage }, uiEffect: null };
};

const DOMAIN_HANDLERS: Record<string, DomainHandler> = {
  ...TODO_DOMAIN_HANDLERS,
  talk_delegate_todo: delegateTodo,
  read_session: (_host, args) => ({ data: sessionData(requiredText(args, "id")), uiEffect: null }),
  talk_send_to_session: sendToSession,
  talk_recall_topic: recallTopic,
  talk_remember_topic: rememberTopic,
  read_talk_capability: readCapability,
};

/** Every operation name this module can execute. Exported so the manifest can
 *  be proven complete rather than assumed to be. */
export const DOMAIN_HANDLER_NAMES: readonly string[] = Object.keys(DOMAIN_HANDLERS);

async function execute(host: TalkControlHost, operation: TalkControlOperation, args: Record<string, unknown>, call: TalkControlAdapterContext): Promise<TalkControlExecution> {
  const handler = DOMAIN_HANDLERS[operation.name];
  if (!handler) throw new Error(`No domain adapter for ${operation.name}`);
  return handler(host, args, call);
}

export function createTalkDomainRuntime(manifest: TalkControlManifest, host: TalkControlHost): TalkControlRuntime {
  return new TalkControlRuntime({
    manifest,
    execute: (operation, args, call) => execute(host, operation, args, call),
    verify: (operation, args, execution) => verifyTalkDomainOperation(operation, args, execution),
    ...(host.receipts ? { receipts: host.receipts } : {}),
  });
}
