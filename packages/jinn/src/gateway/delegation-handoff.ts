import crypto from "node:crypto";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { ChatBlockEnvelope, Employee, JsonObject, Session, WorkItemLinkRole } from "../shared/types.js";
import { clearDelegationCompletionContract, DELEGATION_COMPLETION_TRACKED_META_KEY } from "../sessions/delegation-completion-contract.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { applyBlockEnvelope, claimSessionDelivery, getSession, updateSession } from "../sessions/registry.js";
import { getWorkItemClaim } from "../work-items/claims.js";
import { recordDelegation } from "../work-items/employee-session-delegation.js";
import { toWorkItemLinkRole } from "../work-items/link-role.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { openWorkItemRun } from "../work-items/runs.js";
import { getWorkItem, linkSession, type WorkItem } from "../work-items/store.js";
import { persistAndEmitActivityBlock, type ChatActivityContext } from "./chat-activity.js";
import { rehomeAttachmentsToSession } from "./files.js";
import { surfaceManagerVisibility } from "./manager-visibility.js";
import type { RouteTodoClaim } from "./todo-claim.js";
import { resolveAttachmentPaths } from "./web-session-dispatch.js";
import type { ApiContext } from "./api.js";

/**
 * The tail of a delegation, shared by its two shapes: a new session spawned for
 * the delegate, and the delegate's live session on the Todo that the brief is
 * delivered into instead (one session per employee per Todo).
 */

export interface DelegationAnnouncement {
  context: ApiContext;
  activity: ChatActivityContext;
  parentSessionId: string | undefined;
  delegatorSession: Session | undefined;
  workItem: WorkItem;
  session: Session;
  employeeName: string | undefined;
  engineName: string;
  delegateEmployee: Employee | undefined;
  roster: Map<string, Employee> | undefined;
  title: string;
  dispatchedAt: number;
}

/** The delegation card in the delegator's chat. A reused session's card is
 *  the same card, pointing at the session the brief went to. */
function putHandoffCard(parentSessionId: string, input: DelegationAnnouncement): void {
  const { workItem, session, title } = input;
  const label = input.employeeName ?? input.engineName;
  const handoffEnvelope: ChatBlockEnvelope = {
    op: "put",
    block: {
      id: `dg-${workItem.id}`,
      type: "delegation",
      version: 1,
      status: "running",
      payload: {
        employee: label,
        employeeDisplay: input.delegateEmployee?.displayName ?? label,
        title,
        childSessionId: session.id,
        workItemId: workItem.id,
        dispatchedAt: input.dispatchedAt,
      },
    },
  };
  try {
    applyBlockEnvelope(parentSessionId, handoffEnvelope, title);
    input.context.emit("session:delta", { sessionId: parentSessionId, type: "block", content: title, block: handoffEnvelope });
  } catch (blockErr) {
    logger.warn(`Delegation ${workItem.id} handoff block failed: ${blockErr instanceof Error ? blockErr.message : blockErr}`);
  }
}

/** The card, the skip-level manager's visibility, and the Todo cache signal. */
export function announceDelegation(input: DelegationAnnouncement): void {
  const { parentSessionId, workItem, session, delegatorSession } = input;
  if (parentSessionId && delegatorSession) putHandoffCard(parentSessionId, input);
  if (input.employeeName && input.roster) {
    surfaceManagerVisibility({
      roster: input.roster,
      employee: input.employeeName,
      delegatorSession,
      childSession: session,
      workItemId: workItem.id,
      title: input.title,
    });
  }
  // The delegation card above is the atomic response's sole transcript row.
  // Publish the Todo cache invalidation through the shared boundary without
  // synthesizing a second Todo activity block for the same delegation.
  const delegatedItem = getWorkItem(workItem.id) ?? workItem;
  const eventSessionId = delegatorSession && input.activity.sessionExists(delegatorSession.id) ? delegatorSession.id : undefined;
  persistAndEmitActivityBlock({
    context: input.activity,
    companyEvent: {
      entity: "todo",
      action: "delegated",
      id: delegatedItem.id,
      version: delegatedItem.version,
      value: delegatedItem as unknown as JsonObject,
      ...(eventSessionId ? { sessionId: eventSessionId } : {}),
    },
  });
}

/** The claim a running session already holds: nothing to take, and nothing
 *  to give back if the delegation fails, because the claim was never this
 *  call's. An idle holder's claim is free to anyone, so it is retaken instead. */
export function claimHeldBy(workItemId: string, session: Session): RouteTodoClaim | undefined {
  if (session.status !== "running" && session.status !== "waiting") return undefined;
  if (getWorkItemClaim(workItemId)?.sessionId !== session.id) return undefined;
  return { owner: `session:${session.id}`, bind: () => undefined, release: () => undefined };
}

export interface LandInLiveSessionInput {
  workItem: WorkItem;
  session: Session;
  employeeName: string;
  delegateEmployee: Employee | undefined;
  claim: RouteTodoClaim;
  actor: string;
  role: WorkItemLinkRole;
  /** The delegator the session reports to from now on; undefined for the
   *  operator, who has no session to wake. */
  parentSessionId: string | undefined;
  brief: string;
  title: string;
  /** The delegation's managed file ids. The outbox carries text, so they are
   *  re-homed to the session and the brief names their paths. */
  attachments: string[] | undefined;
  /** A retry with the same key delivers the brief once. */
  idempotencyDigest: string | undefined;
}

function delegatedBrief(input: LandInLiveSessionInput): string {
  const paths = resolveAttachmentPaths(input.attachments);
  const files = paths.length > 0 ? `\n\nAttached files:\n${paths.map((file) => `- ${file}`).join("\n")}` : "";
  return `📋 Todo ${input.workItem.id} has been delegated to you, in the session you already have on it. `
    + `You now hold the Todo, and your report goes to whoever delegated it.\n\n${input.brief}${files}`;
}

/** A session that executed the Todo stays its executor: relinking it as a
 *  reviewer would hide its attempts from the status derivation and lift the
 *  self-review ban. A consultation or a review takes the delegation's role. */
export function relinkRole(session: Session, role: WorkItemLinkRole): WorkItemLinkRole {
  return toWorkItemLinkRole(session.workItemRole) === "execute" ? "execute" : role;
}

/**
 * Land a delegation in the delegate's live session on the Todo.
 *
 * The session takes the claim through the same claim the route already took
 * (or keeps the one it holds), is relinked under the delegation's role, starts
 * a fresh completion contract, and reports to this delegator from now on. The
 * brief goes in through the outbox, behind any turn already running.
 */
export function landInLiveSession(input: LandInLiveSessionInput): void {
  const { workItem, session } = input;
  rehomeAttachmentsToSession(input.attachments, session.id);
  linkSession(workItem.id, session.id, input.actor, relinkRole(session, input.role));
  input.claim.bind(session.id);
  const cleared = clearDelegationCompletionContract(session);
  updateSession(session.id, {
    transportMeta: {
      ...(cleared.transportMeta ?? {}),
      [DELEGATION_COMPLETION_TRACKED_META_KEY]: true,
      ...(input.delegateEmployee?.displayName ? { delegationEmployeeDisplay: input.delegateEmployee.displayName } : {}),
    },
  });
  recordDelegation(workItem.id, input.employeeName, session, input.parentSessionId ?? null);
  try {
    openWorkItemRun({ workItemId: workItem.id, sessionId: session.id });
  } catch (runErr) {
    logger.warn(`Delegation ${workItem.id} run ledger open failed: ${runErr instanceof Error ? runErr.message : runErr}`);
  }
  const { delivery } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "work-item",
    sourceId: workItem.id,
    sourceAttempt: `delegation:${input.idempotencyDigest ?? crypto.randomUUID()}`,
    sourceOutcome: "todo-delegation",
    sourceVersion: 1,
    deliveryKind: "todo-delegation",
    payload: { message: delegatedBrief(input), displayMessage: `📋 ${workItem.id} · delegated to you\n${input.title}` },
  });
  logger.info(`Delegation ${workItem.id}: brief delivered into ${input.employeeName}'s live session ${session.id}`);
  if (delivery.status === "accepted") return;
  // The Todo's status follows the turn the brief starts, so derive it once the
  // session has accepted the brief rather than before it is running.
  deliverClaimedSessionDelivery(delivery.id)
    .then(() => reconcileWorkItem(workItem.id))
    .catch((error) => {
      logger.warn(`Delegation ${workItem.id} could not deliver its brief to session ${session.id}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    });
}

export interface DelegationSelection { engine: string; model?: string; effortLevel?: string }

/**
 * The route's answer for a delegation that landed in a live session. The
 * session keeps the engine, model and effort it was started on, so a delegation
 * that resolved to something else is told so (`selectionIgnored`, with what it
 * asked for) rather than left to believe it got its way.
 */
function selectionOf(selection: { engine: string; model?: string | null; effortLevel?: string | null }): JsonObject {
  return { engine: selection.engine, model: selection.model ?? null, effortLevel: selection.effortLevel ?? null };
}

export function reusedDelegationBody(workItemId: string, reused: Session, title: string, requested: DelegationSelection): JsonObject {
  const current = getSession(reused.id) ?? reused;
  const kept = selectionOf(current);
  const asked = selectionOf(requested);
  const differs = JSON.stringify(kept) !== JSON.stringify(asked);
  if (differs) logger.info(`Delegation ${workItemId}: session ${reused.id} keeps ${JSON.stringify(kept)}; the delegation resolved to ${JSON.stringify(asked)}`);
  return {
    workItemId, sessionId: reused.id, employee: current.employee ?? null, ...kept, status: current.status, title, reused: true,
    ...(differs ? { selectionIgnored: asked } : {}),
  };
}

/** The session an earlier delegation with this idempotency key landed in, if it
 *  landed in a live session rather than spawning one: its brief delivery is the
 *  receipt, keyed on the same digest. */
export function reusedDelegationReceipt(idempotencyDigest: string): Session | undefined {
  const row = initDb().prepare(
    "SELECT target_session_id FROM callback_deliveries WHERE delivery_kind = 'todo-delegation' AND source_attempt = ? LIMIT 1",
  ).get(`delegation:${idempotencyDigest}`) as { target_session_id: string } | undefined;
  return row ? getSession(row.target_session_id) : undefined;
}

/** A session delegating its own Todo to its own employee would land in itself
 *  and report to itself. It already has the work. */
export function selfDelegationError(workItemId: string, session: Session): string {
  return `session ${session.id} is already ${session.employee}'s session on Todo ${workItemId}, so delegating it to `
    + `${session.employee} would land in this same session. Carry on with the work here instead.`;
}
