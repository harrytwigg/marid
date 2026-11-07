import { isBoardWalkTurn } from "../board-walk/started-sessions.js";
import { loadConfig } from "../shared/config.js";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { deliverClaimedSessionDelivery } from "./callbacks.js";
import { describeBackgroundTask, recordLeftBackgroundTasks, type LeftBackgroundTask } from "./left-background-tasks.js";
import { claimSessionDelivery, getSession } from "./registry.js";

const LOST_BACKGROUND_TASKS_DELIVERY_KIND = "lost-background-tasks";
const LOST_BACKGROUND_TASKS_SOURCE_OUTCOME = "engine-process-ended";

/**
 * One nudge per session in this window. Without a bound, sessions that keep
 * background tasks (a dev server, a Monitor) and outnumber the idle PTY cap
 * evict each other for ever: the cap evicts one, its nudge respawns it and it
 * relaunches its task, and once that turn ends the cap evicts the next one. A
 * loss inside the window is logged and left alone, so the session stays down
 * and the cap holds.
 */
export const LOST_BACKGROUND_NUDGE_WINDOW_MS = 30 * 60_000;

/** The slice of a lost task the nudge names. */
export type LostBackgroundTask = LeftBackgroundTask;

export type LostBackgroundTasksResult =
  | { claimed: true; deliveryId: string }
  | { claimed: false; reason: "no-tasks" | "no-session" | "archived" | "board-walk-turn" | "disabled" | "already-nudged" | "already-delivered" | "rate-limited" };

/** The continue turn. It names each task, because the model has to check each one,
 *  and says why their notifications will never come, so it does not wait for them. */
export function lostBackgroundTasksMessage(tasks: readonly LostBackgroundTask[]): string {
  const one = tasks.length === 1;
  const count = one ? "a background task" : `${tasks.length} background tasks`;
  return [
    `[Gateway] This session's engine process ended while ${count} it started ${one ? "was" : "were"} still running. `
      + `Nothing tracks ${one ? "it" : "them"} any more, so ${one ? "its" : "their"} completion notification will never arrive. `
      + `Lost task ids:`,
    ...tasks.map(describeBackgroundTask),
    `${one ? "It" : "Each"} may have been stopped with the process, or may still be running (a crash leaves children behind). `
      + `Check each one's outcome directly (its output, the files or service it touched), then re-run what is still needed `
      + `and continue from where you left off.`,
  ].join("\n");
}

/** Why no one would read a nudge to this session. */
function nobodyReads(session: NonNullable<ReturnType<typeof getSession>>): "archived" | "board-walk-turn" | null {
  if (session.archivedAt) return "archived";
  // The next tick replaces a board walk turn; nobody reads its answer.
  return isBoardWalkTurn(session) ? "board-walk-turn" : null;
}

/** No turn is started for this loss, so the session's next one is told instead of nobody. */
function keepForNextTurn(sessionId: string, tasks: readonly LostBackgroundTask[], reason: "disabled" | "rate-limited"): LostBackgroundTasksResult {
  recordLeftBackgroundTasks(sessionId, tasks, "not-nudged");
  return { claimed: false, reason };
}

/**
 * Ask a session to carry on after its engine process ended under background
 * tasks, through the durable delivery outbox. The claim is keyed on the lost
 * task ids, so one loss is nudged once however often it is reported, and a
 * session is nudged at most once per {@link LOST_BACKGROUND_NUDGE_WINDOW_MS}.
 */
export function notifyLostBackgroundTasks(
  sessionId: string,
  tasks: readonly LostBackgroundTask[],
  now = Date.now(),
): LostBackgroundTasksResult {
  if (tasks.length === 0) return { claimed: false, reason: "no-tasks" };
  const session = getSession(sessionId);
  if (!session) return { claimed: false, reason: "no-session" };
  const skipped = nobodyReads(session);
  if (skipped) return { claimed: false, reason: skipped };
  if (loadConfig().gateway.resumeInterruptedSessions === false) return keepForNextTurn(session.id, tasks, "disabled");
  const outcome = claimNudge(session.id, tasks, now);
  if (outcome === "repeat") return { claimed: false, reason: "already-nudged" };
  if (!outcome) return keepForNextTurn(session.id, tasks, "rate-limited");
  const { delivery, claimed } = outcome;
  if (delivery.status === "accepted") return { claimed: false, reason: "already-delivered" };
  if (!claimed) return { claimed: false, reason: "already-nudged" };
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[lost-background-tasks] Failed to nudge session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { claimed: true, deliveryId: delivery.id };
}

/** Claim the session's one nudge in the window: null when it was nudged within it for another loss,
 *  "repeat" when the same loss was, and the delivery otherwise. */
function claimNudge(sessionId: string, tasks: readonly LostBackgroundTask[], now: number) {
  const message = lostBackgroundTasksMessage(tasks);
  const database = initDb();
  const nudgedSince = database.prepare(
    "SELECT 1 FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = ? AND created_at > ? LIMIT 1",
  );
  const sourceAttempt = `lost-background:${tasks.map((task) => task.id).sort().join(",")}`;
  const sameLoss = database.prepare(
    "SELECT 1 FROM callback_deliveries WHERE target_session_id = ? AND delivery_kind = ? AND source_attempt = ? LIMIT 1",
  );
  // The check and the claim share one transaction, so two losses reported together cannot both pass.
  return database.transaction(() => {
    const since = new Date(now - LOST_BACKGROUND_NUDGE_WINDOW_MS).toISOString();
    if (nudgedSince.get(sessionId, LOST_BACKGROUND_TASKS_DELIVERY_KIND, since)) {
      // The same loss reported again was already told to the session by its nudge.
      return sameLoss.get(sessionId, LOST_BACKGROUND_TASKS_DELIVERY_KIND, sourceAttempt) ? ("repeat" as const) : null;
    }
    return claimSessionDelivery({
      targetSessionId: sessionId,
      sourceKind: "session",
      sourceId: sessionId,
      sourceAttempt,
      sourceOutcome: LOST_BACKGROUND_TASKS_SOURCE_OUTCOME,
      sourceVersion: 1,
      deliveryKind: LOST_BACKGROUND_TASKS_DELIVERY_KIND,
      payload: { message, displayMessage: message },
    });
  }).immediate();
}

/**
 * What the gateway does when a session's engine process ends under background tasks. A session
 * stopped on purpose is not woken, but its next explicit turn is told; any other loss asks the
 * session to carry on, and a nudge that is not sent is kept for its next turn instead (see
 * {@link notifyLostBackgroundTasks}).
 */
export function handleLostBackgroundTasks(sessionId: string, tasks: readonly LostBackgroundTask[], deliberate: boolean): void {
  if (deliberate) {
    recordLeftBackgroundTasks(sessionId, tasks, "stopped");
    return;
  }
  const result = notifyLostBackgroundTasks(sessionId, tasks);
  const ids = tasks.map((task) => task.id).join(", ");
  if (result.claimed) logger.info(`Asked session ${sessionId} to carry on after its process ended under ${tasks.length} background task(s)`);
  else if (result.reason === "rate-limited") {
    logger.warn(`Did not ask session ${sessionId} to carry on after losing background tasks (${ids}): it was already asked within the last ${LOST_BACKGROUND_NUDGE_WINDOW_MS / 60_000}m; its next turn will be told`);
  } else if (result.reason !== "already-nudged" && result.reason !== "already-delivered") {
    logger.info(`Did not ask session ${sessionId} to carry on after losing background tasks (${ids}): ${result.reason}`);
  }
}
