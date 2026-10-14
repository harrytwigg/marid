import crypto from "node:crypto";
import { logger } from "../shared/logger.js";
import type { Employee, Session, WorkItemLinkRole } from "../shared/types.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { claimSessionDelivery, claimSessionDeliveryWithinSourceLimit, createSession, enqueueQueueItem, insertMessage, updateSession } from "../sessions/registry.js";
import { validateNewSessionSelection } from "../sessions/session-patch.js";
import { resolveTodoDispatch } from "../work-items/dispatch-config.js";
import { liveEmployeeSession, resolveEmployeeSession, ROOT_SESSION_SLOT, rootTodoSessionKey } from "../work-items/employee-sessions.js";
import { linkSession } from "../work-items/store.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";
import type { ApiContext } from "./api.js";

/**
 * Waking an employee on a Todo: into the session they already have on it, or
 * into a new one linked to it, never a second one beside the first.
 *
 * The (Todo, employee) record decides which (`work-items/employee-sessions.ts`).
 * A live session gets the message through the durable outbox, which queues it
 * behind a running turn and starts one on an idle, waiting or interrupted
 * session. A new session is created, linked and recorded in one transaction,
 * then dispatched like any other first turn.
 *
 * The org root is woken the same way when it is the virtual portal root: its
 * session carries no employee, so it runs as the portal does, and the record
 * holds it under {@link ROOT_SESSION_SLOT}.
 */

export interface TodoSessionDelivery {
  workItemId: string;
  /** What makes this delivery once-only per target: the comment, the
   *  delegation's idempotency key, or a fresh id when nothing repeats it. */
  sourceAttempt: string;
  deliveryKind: string;
  message: string;
  displayMessage: string;
}

/** Deliver into a live session through the outbox. A repeat of the same
 *  `sourceAttempt` to the same session is accepted once and never re-sent.
 *  With `cap`, at most that many deliveries of this kind leave this Todo; past
 *  it nothing is sent and the answer is false. */
export function deliverIntoSession(session: Session, delivery: TodoSessionDelivery, cap?: number): boolean {
  const identity = {
    targetSessionId: session.id,
    sourceKind: "work-item" as const,
    sourceId: delivery.workItemId,
    sourceAttempt: delivery.sourceAttempt,
    sourceOutcome: delivery.deliveryKind,
    sourceVersion: 1,
    deliveryKind: delivery.deliveryKind,
    payload: { message: delivery.message, displayMessage: delivery.displayMessage },
  };
  const claim = cap === undefined ? claimSessionDelivery(identity) : claimSessionDeliveryWithinSourceLimit(identity, cap);
  const claimed = claim.delivery;
  if (!claimed) return false;
  if (claimed.status === "accepted") return true;
  deliverClaimedSessionDelivery(claimed.id).catch((error) => {
    logger.warn(`Todo ${delivery.workItemId} could not deliver ${delivery.deliveryKind} to session ${session.id}: `
      + `${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}

export interface WakeOnTodoInput extends TodoSessionDelivery {
  /** Why a new session is linked to the Todo. */
  role: WorkItemLinkRole;
  /** The actor the link event records. */
  actor: string;
  title: string;
}

export interface WakeEmployeeInput extends WakeOnTodoInput {
  employee: Employee;
}

export type WakeEmployeeResult =
  | { ok: true; session: Session; started: boolean }
  | { ok: false; error: string };

interface Spawn { engineName: string; model?: string; effortLevel?: string; prompt: string }

function employeeDefaults(employee: Employee): { engine: string; model: string; employee: string; effortLevel?: string } {
  return { engine: employee.engine, model: employee.model, employee: employee.name, ...(employee.effortLevel ? { effortLevel: employee.effortLevel } : {}) };
}

/** What a new session falls back to: the employee's own selection, or just its
 *  name under a Todo's engine override, or the gateway default for the root. */
function spawnDefaults(employee: Employee | null, overridden: boolean): Parameters<typeof validateNewSessionSelection>[2] {
  if (!employee) return {};
  return overridden ? { employee: employee.name } : employeeDefaults(employee);
}

/** The engine a new session runs on: the Todo's own override first, as for a
 *  delegation, then the employee's, or the gateway default for the root. The
 *  Todo's skills prefix the prompt. */
function planSpawn(context: ApiContext, input: WakeOnTodoInput, employee: Employee | null): { ok: true; spawn: Spawn } | { ok: false; error: string } {
  const config = context.getConfig();
  const dispatch = resolveTodoDispatch(input.workItemId, employee?.name);
  if (!dispatch.ok) return { ok: false, error: dispatch.error };
  const override = dispatch.preamble;
  const selection = validateNewSessionSelection(config, {
    engine: override.engine ?? undefined,
    model: override.engine ? override.model ?? undefined : undefined,
  }, spawnDefaults(employee, !!override.engine));
  if (!selection.ok) return { ok: false, error: selection.error || "invalid engine/model/effort" };
  const engineName = selection.engine || config.engines.default;
  if (!context.sessionManager.getEngine(engineName)) return { ok: false, error: `Engine "${engineName}" is not available on this gateway.` };
  return {
    ok: true,
    spawn: {
      engineName,
      model: selection.model,
      effortLevel: selection.effortLevel,
      prompt: override.prefix + input.message,
    },
  };
}

/** A new session linked to the Todo: the employee's, or with none the root's,
 *  which is parentless and employee-less like any portal session. */
function createLinkedSession(context: ApiContext, input: WakeOnTodoInput, employee: Employee | null, spawn: Spawn): Session {
  const sessionKey = employee ? `todo:${input.workItemId}:${employee.name}:${crypto.randomUUID()}` : rootTodoSessionKey(input.workItemId);
  const session = createSession({
    engine: spawn.engineName,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    employee: employee?.name,
    model: spawn.model,
    effortLevel: spawn.effortLevel,
    prompt: spawn.prompt,
    title: input.title.slice(0, 200),
    portalName: context.getConfig().portal?.portalName,
  });
  linkSession(input.workItemId, session.id, input.actor, input.role);
  return session;
}

function startFirstTurn(context: ApiContext, session: Session, spawn: Spawn): void {
  insertMessage(session.id, "user", spawn.prompt);
  const engine = context.sessionManager.getEngine(spawn.engineName);
  if (!engine) {
    updateSession(session.id, { status: "error", lastError: `Engine "${spawn.engineName}" not available` });
    return;
  }
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  session.status = "running";
  const queueKey = session.sessionKey || session.sourceRef || session.id;
  const queueItemId = enqueueQueueItem(session.id, queueKey, spawn.prompt);
  context.emit("queue:updated", { sessionId: session.id, sessionKey: queueKey });
  dispatchWebSessionRun(session, spawn.prompt, engine, context, { queueItemId });
}

function wakeOnTodo(context: ApiContext, input: WakeOnTodoInput, employee: Employee | null): WakeEmployeeResult {
  const slot = employee?.name ?? ROOT_SESSION_SLOT;
  // Delivering needs no engine: only a start is refused for want of one.
  const live = liveEmployeeSession(input.workItemId, slot);
  if (live) {
    deliverIntoSession(live, input);
    return { ok: true, session: live, started: false };
  }
  const planned = planSpawn(context, input, employee);
  if (!planned.ok) return planned;
  const { spawn } = planned;
  const resolved = resolveEmployeeSession(input.workItemId, slot, () => createLinkedSession(context, input, employee, spawn));
  if (resolved.started) startFirstTurn(context, resolved.session, spawn);
  else deliverIntoSession(resolved.session, input);
  return { ok: true, ...resolved };
}

/** Wake `employee` on the Todo with `message`: delivered into their live
 *  session on it, or as the first turn of a new one. */
export function wakeEmployeeOnTodo(context: ApiContext, input: WakeEmployeeInput): WakeEmployeeResult {
  return wakeOnTodo(context, input, input.employee);
}

/** Wake the virtual org root on the Todo: into the root session already on it,
 *  or a new portal session linked to it. Only for a virtual root — an employee
 *  root is woken as the employee it is. */
export function wakeRootOnTodo(context: ApiContext, input: WakeOnTodoInput): WakeEmployeeResult {
  return wakeOnTodo(context, input, null);
}
