import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { getSession } from "../sessions/registry.js";
import {
  claimWorkItem,
  releaseWorkItemClaim,
  releaseWorkItemClaimForSession,
} from "../work-items/claims.js";
import { json } from "./route-helpers.js";
import { TODO_DISPATCHER_NAME } from "./system-employees.js";

/**
 * The claim gate the two pickup routes share (ICI-729).
 *
 * Both `POST /api/delegations` onto an existing Todo and `POST
 * /api/work-items/:id/dispatch` used to ask "does this Todo have a live session?"
 * and then spawn one — two facts, and a second request fits between them. Both
 * now take the claim instead, and the answer they get back IS the decision.
 *
 * Each returns undefined once it has already answered the caller, the same shape
 * as `requireTodoRouteId` and the other route guards: `if (!claim) return;`.
 */
export interface RouteTodoClaim {
  owner: string;
  /** Name the session doing the work, so the claim ends when the attempt does
   *  rather than at the end of the lease. */
  bind(sessionId: string): void;
  /** Hand the Todo straight back. Every path that claims and then fails to
   *  spawn calls this, or the Todo would sit unavailable for the whole lease. */
  release(): void;
}

/** The `code` on a refusal that means somebody is already working the Todo,
 *  so the board can say that plainly instead of a generic failure. */
export const TODO_ALREADY_EXECUTING = "TODO_ALREADY_EXECUTING";

function acquired(workItemId: string, owner: string): RouteTodoClaim {
  return {
    owner,
    bind: (sessionId) => { claimWorkItem({ workItemId, owner, sessionId }); },
    release: () => { releaseWorkItemClaim(workItemId, owner); },
  };
}

/** The Todo itself refused the claim: it is gone, or it is not in the status
 *  the caller required. */
function refuse(res: ServerResponse, workItemId: string, reason: string): undefined {
  json(res, { error: reason, workItemId }, 409);
  return undefined;
}

/**
 * Claim a Todo for a delegation. A Dispatcher handing its own Todo to the
 * employee it picked is the one caller allowed past a live claim: it is not a
 * second worker, it is the same work moving on, so it gives its claim up first.
 *
 * A delegation that MINTED its Todo claims too. Nothing can be racing it yet,
 * but the claim is what the next pickup path reads: without one, the second
 * delegation onto that Todo finds it free and works it a second time.
 */
export function claimTodoForDelegation(
  res: ServerResponse,
  workItemId: string,
  dispatcherCallerId?: string,
): RouteTodoClaim | undefined {
  if (dispatcherCallerId) releaseWorkItemClaimForSession(dispatcherCallerId);
  const owner = `delegation:${randomUUID()}`;
  const claim = claimWorkItem({ workItemId, owner });
  if (claim.state === "acquired") return acquired(workItemId, owner);
  if (claim.state === "rejected") return refuse(res, workItemId, claim.reason);
  json(res, {
    error: `Todo ${workItemId} already has live execution session ${claim.claim.sessionId ?? claim.claim.owner}`,
    workItemId,
    sessionId: claim.claim.sessionId,
  }, 409);
  return undefined;
}

/** The outcome of asking for a Dispatcher claim, before any HTTP shape is put
 *  on it. `reused` is the idempotency receipt — a Dispatcher already holds the
 *  Todo — and `refused` is anything else in the way. Both carry the body the
 *  route answers with, so a non-HTTP caller (the board walk) sees
 *  exactly the reason the route would have sent. */
export type DispatchClaimOutcome =
  | { state: "acquired"; claim: RouteTodoClaim }
  | { state: "reused"; body: { workItemId: string; sessionId: string; status: string; reused: true } }
  | { state: "refused"; status: 409; body: { error: string; workItemId: string; sessionId?: string; code?: string } };

/**
 * Claim a Todo for the built-in Dispatcher. A Dispatcher already working this
 * Todo IS the idempotency receipt — repeat clicks get it back rather than a
 * second one — but anything else holding the Todo is somebody else's work, and
 * a second Dispatcher on top of it is exactly what this gate exists to refuse.
 */
export function takeDispatchClaim(workItemId: string): DispatchClaimOutcome {
  const owner = `dispatch:${randomUUID()}`;
  const claim = claimWorkItem({ workItemId, owner });
  if (claim.state === "acquired") return { state: "acquired", claim: acquired(workItemId, owner) };
  if (claim.state === "rejected") return { state: "refused", status: 409, body: { error: claim.reason, workItemId } };
  const holder = claim.claim.sessionId ? getSession(claim.claim.sessionId) : undefined;
  if (holder?.employee === TODO_DISPATCHER_NAME) {
    return { state: "reused", body: { workItemId, sessionId: holder.id, status: holder.status, reused: true } };
  }
  return {
    state: "refused",
    status: 409,
    body: {
      error: `Todo ${workItemId} is already being worked by ${claim.claim.sessionId ?? claim.claim.owner}`,
      code: TODO_ALREADY_EXECUTING,
      workItemId,
      ...(claim.claim.sessionId ? { sessionId: claim.claim.sessionId } : {}),
    },
  };
}

/** The HTTP face of `takeDispatchClaim`: answers the caller on anything but an
 *  acquired claim, in the same `if (!claim) return;` shape as the other guards. */
export function claimTodoForDispatch(res: ServerResponse, workItemId: string): RouteTodoClaim | undefined {
  const outcome = takeDispatchClaim(workItemId);
  if (outcome.state === "acquired") return outcome.claim;
  json(res, outcome.body, outcome.state === "refused" ? outcome.status : 200);
  return undefined;
}
