import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { Session, SessionDeliveryPayload } from "../shared/types.js";
import { claimSessionDelivery, getSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { isAwaitingOwnBackgroundTask, runtimeActivity } from "../sessions/background-work.js";
import { addComment } from "./comment-add.js";
import { parentOwnerSession } from "./child-settle-wake.js";
import { withReportingParent } from "./employee-session-delegation.js";
import { canMessageSession } from "./employee-sessions.js";
import { isExecutionAttempt } from "./link-role.js";
import { attemptActivity } from "./recovery-controller.js";
import { childWork, type ChildWork } from "./quiet-children.js";
import { appendWorkItemEvent, getWorkItem, listWorkItems, type WorkItem } from "./store.js";
import { DISPATCHER_ALREADY_RUNNING, type AvailabilityRearmResult } from "./availability-resume.js";
import { quietEscalationPayload, quietEscalationReason, quietNudgePayload, type QuietEscalationInput } from "./quiet-watch-message.js";
import { quietWatchFor, recordQuietEscalation, recordQuietNudge, type QuietWatchRow } from "./quiet-watch-rows.js";

/**
 * Noticing an `executing` Todo that has gone quiet: nothing running in its
 * sessions, nothing it delegated still open, and no word for a while.
 *
 * The commonest stall changes no status. A producer ends its turn saying it is
 * waiting on a background test run or a build, the run finishes or dies
 * without waking the session, and the Todo sits in `executing`. Its parent
 * counts an `executing` child as open work, so the parent looks busy too, and
 * the 4 h stall check is the first thing to notice. This watch nudges the
 * producer once after a short quiet, and if that does not move it, tells
 * whoever owns the work from above, once. See specs/006-todo-tree-wake/spec.md,
 * Part D.
 */

export const QUIET_AFTER_MS = 15 * 60_000;
/** While the producer still counts a background shell task of its own: a suite
 *  may run that long, but a shell task may also never end, so it only stretches
 *  the window. */
export const QUIET_BACKGROUND_TASK_MS = 60 * 60_000;
export const QUIET_SWEEP_MS = 60_000;
export const QUIET_WATCH_ACTOR = "quiet-watch";

export interface QuietWindows {
  afterMs: number;
  backgroundTaskMs: number;
}

export interface QuietWatchDeps {
  /** Whether `name` is an employee in the org: not the operator, not empty. */
  isEmployee(name: string): boolean;
  /** Whether `name` is a gateway system employee (the Todo Dispatcher, the Shaper). */
  isSystemEmployee?(name: string): boolean;
  /** Restart a parent's work through the Todo Dispatcher. */
  redispatch(parentId: string, reason: string): AvailabilityRearmResult;
  /** The windows to use now, or null when the watch is turned off. */
  windows?: () => QuietWindows | null;
  now?: () => number;
}

interface QuietTodo {
  item: WorkItem;
  /** When the Todo last entered `executing`: the stint the ladder counts in. */
  stint: string;
  producer: Session | undefined;
  /** The assignee's newest execution session, messageable or not: the one to read. */
  assigneeSessionId: string | undefined;
  quietSince: number;
  awaitingBackgroundTask: boolean;
  /** Its open children: settled ones, and backlog ones the walk will not start. */
  children: ChildWork;
  row: QuietWatchRow | undefined;
}

const time = (iso: string | null | undefined): number => Date.parse(iso ?? "") || 0;

/** The session to nudge: the assignee's newest messageable execution session.
 *  Only the assignee's: a Todo reassigned while executing keeps the previous
 *  holder's session linked, and a Dispatcher is linked to execute too, and
 *  neither is the one to carry the work on. Attempts arrive newest first. */
function producerSession(item: WorkItem, attempts: readonly Session[]): Session | undefined {
  return attempts.find((session) => session.employee === item.assignee && canMessageSession(session));
}

/** The Todo's attempts, stint and children, when nothing speaks for it: no attempt in
 *  flight, nothing it delegated open, and no child being worked or waiting for the
 *  board walk to start it (that is an orchestrator waiting, not a stall). */
function idleTodo(item: WorkItem, now: number): { attempts: Session[]; stint: string; children: ChildWork } | undefined {
  if (item.status !== "executing") return undefined;
  const attempts = listSessionsByWorkItem(item.id).filter(isExecutionAttempt);
  if (attempts.length === 0) return undefined;
  const activity = attemptActivity(item.id, now);
  if (activity.inFlight || !activity.executingSince) return undefined;
  const children = childWork(item.id);
  return children.waiting ? undefined : { attempts, stint: activity.executingSince, children };
}

/** The Todo, read as quiet at `now`, or undefined while anything speaks for it. */
export function quietTodo(item: WorkItem, now: number, windows: QuietWindows): QuietTodo | undefined {
  const idle = idleTodo(item, now);
  if (!idle) return undefined;
  const { attempts, stint, children } = idle;
  const producer = producerSession(item, attempts);
  const awaitingBackgroundTask = !!producer && isAwaitingOwnBackgroundTask(runtimeActivity.get(producer.id));
  const row = quietWatchFor(item.id, stint);
  // The nudge counts as a word: its own turn may not have started yet.
  const quietSince = Math.max(time(stint), time(row?.nudgedAt), ...attempts.map((session) => time(session.lastActivity)));
  const window = awaitingBackgroundTask ? windows.backgroundTaskMs : windows.afterMs;
  if (now - quietSince < window) return undefined;
  const assigneeSessionId = attempts.find((session) => session.employee === item.assignee)?.id;
  return { item, stint, producer, assigneeSessionId, quietSince, awaitingBackgroundTask, children, row };
}

/** Claim one keyed outbox delivery; the id to deliver, or undefined when it was already taken. */
function claim(target: Session, quiet: QuietTodo, step: "nudge" | "escalation", payload: SessionDeliveryPayload): string | undefined {
  const { delivery } = claimSessionDelivery({
    targetSessionId: target.id,
    sourceKind: "work-item",
    sourceId: quiet.item.id,
    sourceAttempt: `quiet-${step}:${quiet.stint}`,
    sourceOutcome: "quiet",
    sourceVersion: 1,
    deliveryKind: `todo-quiet-${step}`,
    payload,
  });
  return delivery.status === "accepted" ? undefined : delivery.id;
}

function deliver(deliveryId: string | undefined, quiet: QuietTodo, target: Session): void {
  if (!deliveryId) return;
  deliverClaimedSessionDelivery(deliveryId).catch((error) => {
    logger.warn(`[quiet-watch] Delivery for ${quiet.item.id} to session ${target.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function audit(quiet: QuietTodo, kind: "quiet_nudged" | "quiet_escalated", detail: Record<string, unknown>): void {
  appendWorkItemEvent({
    workItemId: quiet.item.id,
    kind,
    actor: QUIET_WATCH_ACTOR,
    detail: { stint: quiet.stint, quietSince: new Date(quiet.quietSince).toISOString(), ...detail },
    versionEffect: "audit",
  });
}

function nudge(quiet: QuietTodo, producer: Session, now: number): void {
  const payload = quietNudgePayload({
    item: quiet.item, quietSince: quiet.quietSince, now, awaitingBackgroundTask: quiet.awaitingBackgroundTask, children: quiet.children,
  });
  const db = initDb();
  const deliveryId = db.transaction(() => {
    const id = claim(producer, quiet, "nudge", payload);
    recordQuietNudge(quiet.item.id, quiet.stint, producer.id, new Date(now).toISOString());
    audit(quiet, "quiet_nudged", { sessionId: producer.id, awaitingBackgroundTask: quiet.awaitingBackgroundTask });
    return id;
  })();
  deliver(deliveryId, quiet, producer);
}

type EscalationTarget =
  | { kind: "session"; session: Session }
  | { kind: "redispatch"; parent: WorkItem }
  | { kind: "none" };

/** The parent, when an employee owns it and it is still being worked. */
function ownedParent(item: WorkItem, isEmployee: (name: string) => boolean): { parent: WorkItem; owner: string } | undefined {
  const parent = item.parentId ? getWorkItem(item.parentId) : undefined;
  if (!parent || (parent.status !== "executing" && parent.status !== "blocked")) return undefined;
  return parent.assignee && isEmployee(parent.assignee) ? { parent, owner: parent.assignee } : undefined;
}

/** The session the producer reports to, when it is not the producer. A system
 *  employee does not count: the Dispatcher that started board-walk work can
 *  only nudge once more, so telling it would be a second nudge that nobody above
 *  the work hears of. */
function reportingSession(producer: Session | undefined, isSystemEmployee: (name: string) => boolean): Session | undefined {
  // An errored producer session still says whom it reported to.
  const id = producer ? withReportingParent(producer).parentSessionId : undefined;
  const session = id ? getSession(id) : undefined;
  if (!session || session.id === producer?.id || !canMessageSession(session)) return undefined;
  return session.employee && isSystemEmployee(session.employee) ? undefined : session;
}

/** Whoever owns the work from above: the parent's owner, then who the producer reports to. */
function escalationTarget(quiet: QuietTodo, deps: QuietWatchDeps): EscalationTarget {
  const owned = ownedParent(quiet.item, deps.isEmployee);
  if (owned) {
    const session = parentOwnerSession(owned.parent, owned.owner);
    if (session && session.id !== quiet.producer?.id) return { kind: "session", session };
    if (owned.parent.status === "executing") return { kind: "redispatch", parent: owned.parent };
  }
  const assigneeSession = quiet.producer ?? (quiet.assigneeSessionId ? getSession(quiet.assigneeSessionId) : undefined);
  const reporting = reportingSession(assigneeSession, deps.isSystemEmployee ?? (() => false));
  return reporting ? { kind: "session", session: reporting } : { kind: "none" };
}

function escalationInput(quiet: QuietTodo, now: number): QuietEscalationInput {
  return {
    item: quiet.item,
    sessionId: quiet.row?.nudgeSessionId ?? quiet.assigneeSessionId,
    quietSince: quiet.quietSince,
    nudgedAt: quiet.row?.nudgedAt ? time(quiet.row.nudgedAt) : undefined,
    reachable: quiet.producer !== undefined,
    now,
  };
}

/** No one above to tell: say so on the Todo, where the board and the 4 h check will find it. */
function commentOnTodo(quiet: QuietTodo, input: QuietEscalationInput): void {
  try {
    addComment({
      workItemId: quiet.item.id,
      author: QUIET_WATCH_ACTOR,
      authorKind: "system",
      body: `${quietEscalationPayload(input).message.replace(/^\[Gateway\] /, "")}\n\nNobody above this Todo could be messaged, so nobody was told.`,
      idempotencyKey: `quiet-escalation:${quiet.item.id}:${quiet.stint}`,
    });
  } catch (error) {
    logger.warn(`[quiet-watch] Could not comment on ${quiet.item.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Re-dispatch the parent. A Dispatcher already running reads the escalation's
 *  tree itself; any other refusal, or a throw, started nothing, so the
 *  escalation is left on the parent where whoever resumes it reads it. */
function redispatchParent(parent: WorkItem, quiet: QuietTodo, input: QuietEscalationInput, deps: QuietWatchDeps): void {
  let why: string | undefined;
  try {
    const result = deps.redispatch(parent.id, quietEscalationReason(input));
    if ("unavailable" in result && result.unavailable !== DISPATCHER_ALREADY_RUNNING) why = result.unavailable;
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  if (why === undefined) return;
  logger.warn(`[quiet-watch] Re-dispatching ${parent.id} for ${quiet.item.id} started nothing: ${why}`);
  try {
    addComment({
      workItemId: parent.id,
      author: QUIET_WATCH_ACTOR,
      authorKind: "system",
      body: `${quietEscalationReason(input)}\n\nNothing could be started for this Todo (${why}), so nobody was told.`,
      idempotencyKey: `quiet-escalation:${quiet.item.id}:${quiet.stint}:parent`,
    });
  } catch (error) {
    logger.warn(`[quiet-watch] Could not comment on ${parent.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function escalate(quiet: QuietTodo, deps: QuietWatchDeps, now: number): void {
  const input = escalationInput(quiet, now);
  const target = escalationTarget(quiet, deps);
  const db = initDb();
  const deliveryId = db.transaction(() => {
    const id = target.kind === "session" ? claim(target.session, quiet, "escalation", quietEscalationPayload(input)) : undefined;
    recordQuietEscalation(quiet.item.id, quiet.stint, new Date(now).toISOString());
    audit(quiet, "quiet_escalated", target.kind === "session"
      ? { to: "session", sessionId: target.session.id }
      : target.kind === "redispatch" ? { to: "redispatch", parentId: target.parent.id } : { to: "none" });
    return id;
  })();
  if (target.kind === "session") deliver(deliveryId, quiet, target.session);
  else if (target.kind === "redispatch") redispatchParent(target.parent, quiet, input, deps);
  else commentOnTodo(quiet, input);
}

/** Take the next step for one quiet Todo: a nudge, else the escalation, else nothing. */
function step(quiet: QuietTodo, deps: QuietWatchDeps, now: number): void {
  if (quiet.row?.escalatedAt) return;
  if (!quiet.row?.nudgedAt && quiet.producer) nudge(quiet, quiet.producer, now);
  else escalate(quiet, deps, now);
}

const DEFAULT_WINDOWS: QuietWindows = { afterMs: QUIET_AFTER_MS, backgroundTaskMs: QUIET_BACKGROUND_TASK_MS };

/** Act on one Todo if it is quiet and the ladder has a step left. Whether it acted. */
function watchOne(item: WorkItem, deps: QuietWatchDeps, now: number, windows: QuietWindows): boolean {
  // An operator's own Todo, or one nobody holds, is nobody's to nudge.
  if (!item.assignee || !deps.isEmployee(item.assignee)) return false;
  const quiet = quietTodo(item, now, windows);
  if (!quiet || quiet.row?.escalatedAt) return false;
  step(quiet, deps, now);
  return true;
}

/** One pass over the `executing` Todos. Returns how many were acted on. */
export function sweepQuietTodos(deps: QuietWatchDeps): number {
  const windows = deps.windows ? deps.windows() : DEFAULT_WINDOWS;
  if (!windows) return 0;
  const now = (deps.now ?? Date.now)();
  let acted = 0;
  for (const item of listWorkItems({ status: "executing" })) {
    try {
      if (watchOne(item, deps, now, windows)) acted++;
    } catch (error) {
      logger.warn(`[quiet-watch] ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return acted;
}

/** Sweep every {@link QUIET_SWEEP_MS}. Returns the function that stops it. */
export function startQuietWatch(deps: QuietWatchDeps): () => void {
  const timer = setInterval(() => {
    try {
      const acted = sweepQuietTodos(deps);
      if (acted > 0) logger.info(`[quiet-watch] acted on ${acted} quiet Todo(s)`);
    } catch (error) {
      logger.warn(`[quiet-watch] Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, QUIET_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
