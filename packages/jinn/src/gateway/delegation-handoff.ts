import crypto from "node:crypto";
import { logger } from "../shared/logger.js";
import type { ChatBlockEnvelope, Employee, JsonObject, Session, WorkItemLinkRole } from "../shared/types.js";
import { clearDelegationCompletionContract, DELEGATION_COMPLETION_TRACKED_META_KEY } from "../sessions/delegation-completion-contract.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { applyBlockEnvelope, claimSessionDelivery, updateSession } from "../sessions/registry.js";
import { getWorkItemClaim } from "../work-items/claims.js";
import { recordDelegation } from "../work-items/employee-sessions.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { openWorkItemRun } from "../work-items/runs.js";
import { getWorkItem, linkSession, type WorkItem } from "../work-items/store.js";
import { persistAndEmitActivityBlock, type ChatActivityContext } from "./chat-activity.js";
import { surfaceManagerVisibility } from "./manager-visibility.js";
import type { RouteTodoClaim } from "./todo-claim.js";
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

/** The claim a session already holds: nothing to take, and nothing to give
 *  back if the delegation fails, because the claim was never this call's. */
export function claimHeldBy(workItemId: string, sessionId: string): RouteTodoClaim | undefined {
  if (getWorkItemClaim(workItemId)?.sessionId !== sessionId) return undefined;
  return { owner: `session:${sessionId}`, bind: () => undefined, release: () => undefined };
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
  /** A retry with the same key delivers the brief once. */
  idempotencyDigest: string | undefined;
}

function delegatedBrief(input: LandInLiveSessionInput): string {
  return `📋 Todo ${input.workItem.id} has been delegated to you, in the session you already have on it. `
    + `You now hold the Todo, and your report goes to whoever delegated it.\n\n${input.brief}`;
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
  linkSession(workItem.id, session.id, input.actor, input.role);
  input.claim.bind(session.id);
  const cleared = clearDelegationCompletionContract(session);
  updateSession(session.id, {
    transportMeta: {
      ...(cleared.transportMeta ?? {}),
      [DELEGATION_COMPLETION_TRACKED_META_KEY]: true,
      ...(input.delegateEmployee?.displayName ? { delegationEmployeeDisplay: input.delegateEmployee.displayName } : {}),
    },
  });
  recordDelegation(workItem.id, input.employeeName, session.id, input.parentSessionId ?? null);
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
