import { isBoardWalkTurn } from "../board-walk/started-sessions.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { BackgroundTaskWait } from "../shared/session-waits.js";
import { deliverClaimedSessionDelivery } from "./callbacks.js";
import { claimSessionDelivery, getSession } from "./registry.js";

const LOST_BACKGROUND_TASKS_DELIVERY_KIND = "lost-background-tasks";
const LOST_BACKGROUND_TASKS_SOURCE_OUTCOME = "engine-process-ended";

/** The slice of a lost task the nudge names. */
export type LostBackgroundTask = Pick<BackgroundTaskWait, "id" | "kind" | "command" | "description" | "agentType">;

export type LostBackgroundTasksResult =
  | { claimed: true; deliveryId: string }
  | { claimed: false; reason: "no-tasks" | "no-session" | "archived" | "board-walk-turn" | "disabled" | "already-nudged" | "already-delivered" };

const KIND_LABELS: Record<LostBackgroundTask["kind"], string> = {
  process: "background Bash",
  monitor: "Monitor",
  subagent: "background sub-agent",
};

function describeTask(task: LostBackgroundTask): string {
  const what = task.kind === "subagent" ? task.agentType : task.command;
  const parts = [
    `${task.id} (${KIND_LABELS[task.kind]})`,
    ...(task.description ? [task.description] : []),
    ...(what ? [`\`${what}\``] : []),
  ];
  return `- ${parts.join(": ")}`;
}

/** The continue turn. It names each task, because the model has to check each one,
 *  and says why their notifications will never come, so it does not wait for them. */
export function lostBackgroundTasksMessage(tasks: readonly LostBackgroundTask[]): string {
  const one = tasks.length === 1;
  const count = one ? "a background task" : `${tasks.length} background tasks`;
  return [
    `[Gateway] This session's engine process ended while ${count} it started ${one ? "was" : "were"} still running. `
      + `Nothing tracks ${one ? "it" : "them"} any more, so ${one ? "its" : "their"} completion notification will never arrive. `
      + `Lost task ids:`,
    ...tasks.map(describeTask),
    `${one ? "It" : "Each"} may have been stopped with the process, or may still be running (a crash leaves children behind). `
      + `Check each one's outcome directly (its output, the files or service it touched), then re-run what is still needed `
      + `and continue from where you left off.`,
  ].join("\n");
}

/**
 * Ask a session to carry on after its engine process ended under background
 * tasks, through the durable delivery outbox. The claim is keyed on the lost
 * task ids, so one loss is nudged once however often it is reported.
 */
export function notifyLostBackgroundTasks(sessionId: string, tasks: readonly LostBackgroundTask[]): LostBackgroundTasksResult {
  if (tasks.length === 0) return { claimed: false, reason: "no-tasks" };
  const session = getSession(sessionId);
  if (!session) return { claimed: false, reason: "no-session" };
  if (session.archivedAt) return { claimed: false, reason: "archived" };
  // The next tick replaces a board walk turn; nobody reads its answer.
  if (isBoardWalkTurn(session)) return { claimed: false, reason: "board-walk-turn" };
  if (loadConfig().gateway.resumeInterruptedSessions === false) return { claimed: false, reason: "disabled" };
  const message = lostBackgroundTasksMessage(tasks);
  const { delivery, claimed } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "session",
    sourceId: session.id,
    sourceAttempt: `lost-background:${tasks.map((task) => task.id).sort().join(",")}`,
    sourceOutcome: LOST_BACKGROUND_TASKS_SOURCE_OUTCOME,
    sourceVersion: 1,
    deliveryKind: LOST_BACKGROUND_TASKS_DELIVERY_KIND,
    payload: { message, displayMessage: message },
  });
  if (delivery.status === "accepted") return { claimed: false, reason: "already-delivered" };
  if (!claimed) return { claimed: false, reason: "already-nudged" };
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[lost-background-tasks] Failed to nudge session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { claimed: true, deliveryId: delivery.id };
}
