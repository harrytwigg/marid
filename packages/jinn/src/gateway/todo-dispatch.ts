import crypto from "node:crypto";
import { createSession, insertMessage, updateSession } from "../sessions/registry.js";
import { enqueueQueueItem } from "../sessions/queue-item-registry.js";
import { linkSession, type WorkItem } from "../work-items/store.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { resolveTodoDispatch } from "../work-items/dispatch-config.js";
import { logger } from "../shared/logger.js";
import type { Employee, Engine, Session } from "../shared/types.js";
import { orgRegistry } from "./org-registry.js";
import { preflightSystemEmployee } from "./system-employee-spawn.js";
import { TODO_DISPATCHER_NAME } from "./system-employees.js";
import { takeDispatchClaim, type RouteTodoClaim } from "./todo-claim.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";
import type { ApiContext } from "./api.js";

/**
 * Starting the built-in Todo Dispatcher on a Todo, as one act with two callers.
 *
 * `POST /api/work-items/:id/dispatch` used to hold this recipe inline. The
 * idle-capacity auto-start needs to start the very same Dispatcher
 * from a timer, with no request or response in hand — and a second, subtly
 * different spawn is how one of them rots. So the recipe lives here, answers in
 * the route's own shapes (status code plus body), and the route is the thin
 * HTTP face over it. Caller authority and the sticky-status check stay with the
 * route: they are about WHO is asking, and the timer is the gateway itself.
 */

export interface TodoDispatchStarted {
  workItemId: string;
  sessionId: string;
  status: string;
  reused: boolean;
}

export type StartTodoDispatcherResult =
  | { ok: true; status: 200 | 201; body: TodoDispatchStarted }
  | { ok: false; status: number; body: { error: string; workItemId?: string; sessionId?: string } };

export interface StartTodoDispatcherOptions {
  /** ICI-570 change signal for the Todo's projections; the route wires its own
   *  activity-block emitter, a non-HTTP caller may pass nothing. */
  emitProjectionEvent?: (workItemId: string, action: string) => void;
  /** A closing paragraph for the Dispatcher's prompt: what this start is for,
   *  when that should steer the routing (the idle-capacity auto-start says
   *  "this is Claude allowance being used, prefer a Claude employee"). */
  promptSuffix?: string;
}

/** Everything a spawn needs, resolved and claimed, before a session exists. */
interface DispatcherPlan {
  claim: RouteTodoClaim;
  dispatcher: Employee;
  engineName: string;
  model: string | undefined;
  engine: Engine;
  prompt: string;
}

type PlanResult = { ok: true; plan: DispatcherPlan } | { ok: false; result: StartTodoDispatcherResult };

function failure(status: number, error: string): PlanResult {
  return { ok: false, result: { ok: false, status, body: { error } } };
}

function dispatcherPrompt(item: WorkItem, prefix: string, suffix: string | undefined): string {
  return prefix + [
    `Dispatch Todo ${item.id}.`,
    `Title: ${item.title}`,
    item.body ? `Body:\n${item.body}` : "Body: (none)",
    item.acceptance ? `Acceptance criteria:\n${item.acceptance}` : "Acceptance criteria: (none)",
    ...(suffix ? [suffix] : []),
  ].join("\n\n");
}

/** Resolve preferences, take the claim, and preflight the engine — releasing
 *  the claim on every path that cannot go on to spawn. */
function planDispatcher(item: WorkItem, context: ApiContext, suffix: string | undefined): PlanResult {
  // The Todo's own dispatch preferences are resolved BEFORE the claim, so a
  // Todo whose skills have all been uninstalled fails without holding one.
  const dispatchPrefs = resolveTodoDispatch(item.id);
  if (!dispatchPrefs.ok) return failure(409, dispatchPrefs.error);

  const claimed = takeDispatchClaim(item.id);
  if (claimed.state === "reused") return { ok: false, result: { ok: true, status: 200, body: claimed.body } };
  if (claimed.state === "refused") return { ok: false, result: { ok: false, status: claimed.status, body: claimed.body } };
  const claim = claimed.claim;

  const config = context.getConfig();
  const dispatcher = orgRegistry(config).get(TODO_DISPATCHER_NAME);
  if (!dispatcher?.system) {
    claim.release();
    return failure(500, "the built-in Todo Dispatcher is unavailable");
  }
  // The Todo's override beats the Dispatcher employee's own engine/model:
  // it exists to move a stuck Todo onto another engine, so it has to win.
  const engineName = dispatchPrefs.preamble.engine ?? dispatcher.engine;
  const model = dispatchPrefs.preamble.engine ? dispatchPrefs.preamble.model ?? undefined : dispatcher.model;
  const preflight = preflightSystemEmployee({
    employee: dispatcher, label: "Todo Dispatcher", settingLabel: "Dispatcher",
    engineName, globalMcp: config.mcp,
    getEngine: (name) => context.sessionManager.getEngine(name),
  });
  if (!preflight.ok) {
    claim.release();
    return failure(preflight.status, preflight.error);
  }
  return {
    ok: true,
    plan: { claim, dispatcher, engineName, model, engine: preflight.engine, prompt: dispatcherPrompt(item, dispatchPrefs.preamble.prefix, suffix) },
  };
}

function createDispatcherSession(item: WorkItem, plan: DispatcherPlan, context: ApiContext): Session {
  const sessionKey = `todo-dispatcher:${item.id}:${crypto.randomUUID()}`;
  return createSession({
    engine: plan.engineName,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    employee: plan.dispatcher.name,
    model: plan.model,
    effortLevel: plan.dispatcher.effortLevel,
    prompt: plan.prompt,
    title: `Dispatch ${item.id}`,
    portalName: context.getConfig().portal?.portalName,
  });
}

function runDispatcherSession(item: WorkItem, session: Session, plan: DispatcherPlan, context: ApiContext): void {
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  session.status = "running";
  try {
    reconcileWorkItem(item.id);
  } catch (error) {
    logger.warn(`Todo Dispatcher ${session.id} reconcile failed: ${error instanceof Error ? error.message : error}`);
  }
  const queueKey = session.sessionKey || session.sourceRef || session.id;
  const queueItemId = enqueueQueueItem(session.id, queueKey, plan.prompt);
  context.emit("queue:updated", { sessionId: session.id, sessionKey: queueKey });
  dispatchWebSessionRun(session, plan.prompt, plan.engine, context, { queueItemId });
}

export function startTodoDispatcher(
  item: WorkItem,
  context: ApiContext,
  opts: StartTodoDispatcherOptions = {},
): StartTodoDispatcherResult {
  const planned = planDispatcher(item, context, opts.promptSuffix);
  if (!planned.ok) return planned.result;
  const { plan } = planned;

  const session = createDispatcherSession(item, plan, context);
  insertMessage(session.id, "user", plan.prompt);
  try {
    linkSession(item.id, session.id);
    plan.claim.bind(session.id);
  } catch (error) {
    plan.claim.release();
    return {
      ok: false,
      status: 500,
      body: { error: `Todo Dispatcher was not started because its session could not be linked: ${error instanceof Error ? error.message : String(error)}` },
    };
  }

  runDispatcherSession(item, session, plan, context);
  opts.emitProjectionEvent?.(item.id, "dispatched");
  return {
    ok: true,
    status: 201,
    body: { workItemId: item.id, sessionId: session.id, status: session.status, reused: false },
  };
}
