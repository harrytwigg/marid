import { logger } from "../shared/logger.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import {
  claimSessionDeliveryWithinSourceLimit,
  listSessionsByWorkItem,
} from "../sessions/registry.js";
import { addComment, type WorkItemComment } from "../work-items/comments.js";
import { isLegacyWorkflowPhaseSession } from "../sessions/legacy-workflow-phase.js";

/**
 * A comment on a Todo reaches whoever is doing the work, while they are still
 * doing it. Without this the board is a letterbox nobody opens until the work is
 * already finished and the steering is worthless.
 *
 * A Todo has one target, never two: the newest live session delegated to it,
 * an ordinary conversation where any author except the target itself may steer.
 *
 * Delivery claims through the outbox, so a comment is forwarded at
 * most once no matter how often this is called — including across a gateway
 * restart, where the composite unique index is the only thing standing between a
 * recovery sweep and a replayed history.
 */

/** A Todo thread that has needed six mid-flight corrections needs a
 *  conversation, not a seventh. */
export const MAX_STEERING_COMMENTS_PER_TODO = 5;

/**
 * The newest live session working this Todo. `idle` counts alongside `running`
 * because the outbox queues behind a running turn and delivers straight to an
 * idle one: restricting to `running` would drop every comment that lands in the
 * gap between two turns, which is exactly when an operator reads the result and
 * has something to say. An errored session is skipped the way a parent callback
 * skips one.
 */
function latestDelegatedSession(todoId: string) {
  return listSessionsByWorkItem(todoId).find((session) =>
    (session.status === "running" || session.status === "idle") && !isLegacyWorkflowPhaseSession(session));
}

function steeringPrompt(comment: WorkItemComment): string {
  return `💬 ${comment.author} commented on Todo ${comment.workItemId}, which you are working on.\n\n`
    + `${comment.body}\n\n`
    + `Answer on the Todo by calling comment_work_item { id: "${comment.workItemId}", body: "<answer>", `
    + `parentCommentId: "${comment.id}" }, then carry on with the work you already had in hand.`;
}

/** Steer the newest live delegated session with the Todo's conversation. */
export function forwardTodoComment(comment: WorkItemComment): void {
  const session = latestDelegatedSession(comment.workItemId);
  if (!session) return;
  // Never hand a comment back to the identity that wrote it: the prompt asks the
  // session to answer on the Todo, so echoing its own answer to it is the loop.
  // An employee-backed session matches at the EMPLOYEE level, so a sibling
  // session of the same employee is filtered out too — the safe direction.
  if (comment.authorKind === "system") return;
  if (comment.author === (session.employee ?? `session:${session.id}`)) return;

  const claim = claimSessionDeliveryWithinSourceLimit({
    targetSessionId: session.id,
    sourceKind: "work-item",
    sourceId: comment.workItemId,
    sourceAttempt: comment.id,
    sourceOutcome: "todo-comment",
    sourceVersion: 1,
    deliveryKind: "todo-comment-steering",
    payload: {
      message: steeringPrompt(comment),
      displayMessage: `💬 ${comment.workItemId} · ${comment.author}\n${comment.body}`,
    },
  }, MAX_STEERING_COMMENTS_PER_TODO);
  if (claim.capped) {
    addComment({
      workItemId: comment.workItemId,
      parentCommentId: comment.id,
      author: "jinn",
      authorKind: "system",
      body: `**Comment not forwarded** — this Todo has already steered `
        + `${MAX_STEERING_COMMENTS_PER_TODO} comments into its session, which is the cap. `
        + `The session is unchanged and did not see this comment; reply in the session itself if it cannot wait.`,
    });
    return;
  }
  if (!claim.delivery || claim.delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(claim.delivery.id).catch((error) => {
    logger.warn(`Todo ${comment.workItemId} could not deliver comment ${comment.id} `
      + `to session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}
