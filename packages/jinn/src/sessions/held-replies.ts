import { getSession, holdInterimReply, listHeldInterimReplySessionIds, takeHeldInterimReply } from "./registry.js";
import { parseMetaColumn } from "./message-row.js";
import { logger } from "../shared/logger.js";
import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";
import { OPEN_EXECUTION_STATUSES } from "./delegation-completion-contract.js";
import { asksOrReportsBlocker } from "./stop-nudge.js";
import { isAwaitingOwnBackgroundTask, runtimeActivity } from "./background-work.js";
import { getWorkItem } from "../work-items/store.js";
import { withReportingParent } from "../work-items/employee-session-delegation.js";

// A shell task that never ends (a dev server) would hold every reply of a child
// that is otherwise done. After this many held in a row the next one goes out.
export const INTERIM_RELAY_HOLD_CAP = 25;
// A held reply is never lost: once this long has passed since the first of a
// run of held replies, with nothing relayed meanwhile, the parent gets the
// newest one. It also bounds the wake rate of a long wait to one per this
// period. A restart relays a held reply at startup instead.
export const HELD_REPLY_MAX_AGE_MS = 45 * 60_000;
// When what a held reply waited on is over, the reply that follows (the re-run
// a finished task wakes) normally supersedes it within seconds. This long with
// no newer reply, no re-run and no turn running, the held one goes out.
export const HELD_REPLY_SETTLE_MS = 15_000;
// How far back a settled turn looks for the messages that prompted it.
const PROMPT_SCAN_ROWS = 50;

const heldReplies = new Map<string, {
  workItemId: string;
  maxAge?: ReturnType<typeof setTimeout>;
  settle?: ReturnType<typeof setTimeout>;
}>();

/** How a held reply reaches the parent: the sender, and the longest reply it
 *  carries (a longer one is stored clipped to that). */
export interface HeldReplyRelay {
  send(child: Session, text: string, attemptQualifier: string): Promise<void>;
  maxChars: number;
}
let relay: HeldReplyRelay | undefined;

/** callbacks.ts hands over its sender when it loads: it owns the outbox, and
 *  importing it from here would make a cycle. */
export function setHeldReplyRelay(next: HeldReplyRelay): void {
  relay = next;
}

/**
 * Whether this reply is held back from the parent because the child is still
 * waiting on its own background work. The gate is structural: the child's Todo
 * is still open and the engine still counts a background task of the child's
 * (a shell task or a sub-agent), whose end wakes the child again. The text is
 * only a filter that errs toward relaying: a reply that asks the parent
 * something or reports a blocker always goes out. A turn the parent prompted
 * (`settledTurn`, a message from the parent among its prompts) is an answer
 * and goes out too. The caller relays errors and explicit reports itself.
 *
 * A held reply is parked with the session, the newest replacing the older, and
 * goes out unless a newer reply supersedes it: once the counted tasks are over
 * or the Todo has left execution and no newer reply follows (reviewHeldInterimReply),
 * after HELD_REPLY_MAX_AGE_MS, or at the next startup. So a final report written
 * while a task still runs is delayed only until that task ends. Neither the
 * completion contract nor the delegation block is touched for a held reply: a
 * wait is not a completion to judge, and the delegation is not done.
 *
 * A reply that is not held supersedes the held one. Fail-safe: any failure
 * here relays as before.
 */
export function holdsInterimRelay(
  childSession: Session,
  text: string,
  options?: { alwaysNotify?: boolean; settledTurn?: boolean },
): boolean {
  try {
    const workItemId = holdableWorkItem(childSession, text, options);
    if (
      workItemId
      && holdInterimReply(childSession.id, { text: text.trim().slice(0, relay?.maxChars), workItemId, at: Date.now() }, INTERIM_RELAY_HOLD_CAP)
    ) {
      trackHeldReply(childSession.id, workItemId);
      logger.debug(`[callbacks] Held a reply of child ${childSession.id}: its background work is still open`);
      return true;
    }
  } catch (error) {
    logger.warn(`[callbacks] Could not hold a reply of child ${childSession.id}; relaying it: ${error instanceof Error ? error.message : String(error)}`);
  }
  releaseHeldReply(childSession.id);
  return false;
}

/** The open Todo a reply may be held under, or undefined when it must go out. */
function holdableWorkItem(
  childSession: Session,
  text: string,
  options?: { alwaysNotify?: boolean; settledTurn?: boolean },
): string | undefined {
  const workItemId = childSession.workItemId;
  if (options?.alwaysNotify === false || !workItemId) return undefined;
  if (!isAwaitingOwnBackgroundTask(runtimeActivity.get(childSession.id)) || asksOrReportsBlocker(text)) return undefined;
  if (options?.settledTurn && turnAnswersParent(childSession)) return undefined;
  return isOpenForExecution(workItemId) ? workItemId : undefined;
}

function isOpenForExecution(workItemId: string): boolean {
  const item = getWorkItem(workItemId);
  return !!item && OPEN_EXECUTION_STATUSES.has(item.status);
}

/**
 * Whether the turn that just settled was prompted by a message from the
 * child's parent: one of the inbound messages after the child's previous reply
 * is the parent's send_to_session. The settled reply is already stored, so the
 * walk skips the child's own rows first. It errs toward relaying, which only
 * costs a wake: a message that arrived mid-turn for the next turn counts, and
 * a turn whose prompt was never stored is judged by the previous turn's.
 */
function turnAnswersParent(childSession: Session): boolean {
  const parentId = withReportingParent(childSession).parentSessionId;
  if (!parentId) return false;
  const rows = initDb()
    .prepare("SELECT role, meta FROM messages WHERE session_id = ? ORDER BY timestamp DESC, COALESCE(seq, 0) DESC, rowid DESC LIMIT ?")
    .all(childSession.id, PROMPT_SCAN_ROWS) as Array<{ role: string; meta: unknown }>;
  let inPrompts = false;
  for (const row of rows) {
    const inbound = row.role === "user" || row.role === "notification";
    if (!inbound && inPrompts) return false;
    if (!inbound) continue;
    inPrompts = true;
    const meta = parseMetaColumn(row.meta);
    if (meta?.kind === "agent-relay" && meta.fromSessionId === parentId) return true;
  }
  return false;
}

function trackHeldReply(sessionId: string, workItemId: string): void {
  const entry = heldReplies.get(sessionId) ?? { workItemId };
  entry.workItemId = workItemId;
  // A reply was just held, so a task is counted: whatever was settling is moot.
  if (entry.settle) clearTimeout(entry.settle);
  entry.settle = undefined;
  if (!entry.maxAge) {
    entry.maxAge = setTimeout(() => {
      entry.maxAge = undefined;
      void flushHeldInterimReply(sessionId);
    }, HELD_REPLY_MAX_AGE_MS);
    entry.maxAge.unref?.();
  }
  heldReplies.set(sessionId, entry);
}

function untrackHeldReply(sessionId: string): void {
  const entry = heldReplies.get(sessionId);
  if (entry?.maxAge) clearTimeout(entry.maxAge);
  if (entry?.settle) clearTimeout(entry.settle);
  heldReplies.delete(sessionId);
}

/** A reply is going to the parent, or the child reported on its own: the held
 *  one is superseded and its count starts over. Never throws. */
export function releaseHeldReply(sessionId: string): void {
  untrackHeldReply(sessionId);
  try {
    takeHeldInterimReply(sessionId);
  } catch (error) {
    logger.warn(`[callbacks] Could not clear the held reply of child ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Whether nothing a held reply waited on is left: no turn or re-run is running
 *  whose own reply would supersede it, and either no task is counted any more
 *  or the child's Todo has left execution. */
function heldReplyIsDue(sessionId: string, workItemId: string): boolean {
  const info = runtimeActivity.get(sessionId);
  if (info?.backgroundRerun === true || getSession(sessionId)?.status === "running") return false;
  return !isAwaitingOwnBackgroundTask(info) || !isOpenForExecution(workItemId);
}

function dueOrDoubt(sessionId: string, workItemId: string): boolean {
  try {
    return heldReplyIsDue(sessionId, workItemId);
  } catch (error) {
    logger.warn(`[callbacks] Could not judge the held reply of child ${sessionId}; relaying it: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

/**
 * Something a held reply depends on changed: the child's runtime activity, or
 * its Todo's status. If what the reply waited on is over, relay it after
 * HELD_REPLY_SETTLE_MS unless a newer reply supersedes it first; if not, stand
 * down any such pending relay. A no-op for a child with nothing held. Never
 * throws; doubt counts as due.
 */
export function reviewHeldInterimReply(sessionId: string): void {
  const entry = heldReplies.get(sessionId);
  if (!entry) return;
  if (!dueOrDoubt(sessionId, entry.workItemId)) {
    if (entry.settle) clearTimeout(entry.settle);
    entry.settle = undefined;
    return;
  }
  if (entry.settle) return;
  entry.settle = setTimeout(() => {
    entry.settle = undefined;
    if (heldReplies.get(sessionId) !== entry || !dueOrDoubt(sessionId, entry.workItemId)) return;
    void flushHeldInterimReply(sessionId);
  }, HELD_REPLY_SETTLE_MS);
  entry.settle.unref?.();
}

/** reviewHeldInterimReply for every child holding a reply under this Todo. */
export function reviewHeldInterimRepliesForWorkItem(workItemId: string): void {
  for (const [sessionId, entry] of [...heldReplies]) {
    if (entry.workItemId === workItemId) reviewHeldInterimReply(sessionId);
  }
}

/** The Todo status listener for held replies: a Todo that leaves execution
 *  lets its children's held replies go, even if a task they launched never ends. */
export function reviewHeldInterimRepliesOnTodoStatusChange(event: { toStatus: string; item: { id: string } }): void {
  if (!OPEN_EXECUTION_STATUSES.has(event.toStatus)) reviewHeldInterimRepliesForWorkItem(event.item.id);
}

/** Hand the parent the newest held reply of a child, once. Returns whether there was one. */
export async function flushHeldInterimReply(sessionId: string): Promise<boolean> {
  untrackHeldReply(sessionId);
  const held = takeHeldInterimReply(sessionId);
  if (!held) return false;
  const stored = getSession(sessionId);
  if (!stored) return false;
  const child = withReportingParent(stored);
  if (!child.parentSessionId || !relay) return false;
  await relay.send(child, held.text, `held:${held.at}`).catch((err) => {
    logger.warn(`[callbacks] Failed to relay a held reply of child ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
  return true;
}

/** At startup nothing is running any more, so no reply held before the restart
 *  can still be a wait: relay each one. */
export async function recoverHeldInterimReplies(): Promise<void> {
  for (const sessionId of listHeldInterimReplySessionIds()) {
    await flushHeldInterimReply(sessionId).catch((err) => {
      logger.warn(`[callbacks] Held-reply recovery failed for child ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export function __resetHeldRepliesForTest(): void {
  for (const sessionId of [...heldReplies.keys()]) untrackHeldReply(sessionId);
}
