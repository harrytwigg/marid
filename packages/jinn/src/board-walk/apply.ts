import { logger } from "../shared/logger.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { transition } from "../work-items/transitions.js";
import { addComment } from "../work-items/comment-add.js";
import type { StartTodoDispatcherResult } from "../gateway/todo-dispatch.js";
import type { BoardWalkSettings } from "./settings.js";
import type { StartDecision, TodoDecision, WalkDecisions } from "./decisions.js";
import { OPEN_STATUSES, noAutoStartReason, statusSince } from "./board.js";
import type { BoardWalkState, TickEntry } from "./store.js";

/**
 * Carry out the walk's decisions. The model proposes; this module disposes:
 *
 *   - a switched-off action is refused, whatever the model asked for;
 *   - every move is checked against the Todo's state NOW, not as it was when
 *     the prompt was built (a tick takes a minute; the board moves);
 *   - a start goes through the same Todo Dispatcher the dispatch button uses,
 *     and never to a Todo that opted out of automatic starts or belongs to the
 *     operator;
 *   - a stuck Todo is commented on once per stuck episode, across ticks;
 *   - every decision, done or refused, becomes a tick-log entry with the
 *     model's reason and what actually happened.
 */

export const BOARD_WALK_ACTOR = "board-walk";

export interface ApplyDeps {
  settings: BoardWalkSettings;
  state: BoardWalkState;
  dispatch: (item: WorkItem, decision: StartDecision) => StartTodoDispatcherResult;
  now: () => number;
}

const OPEN = new Set<string>(OPEN_STATUSES);

/** A stuck episode: the status the Todo is stuck in, and since when. The same
 *  Todo stuck again after it moved is a new episode and may be flagged again. */
export function stuckEpisode(item: WorkItem): string {
  return `${item.status}@${statusSince(item)}`;
}

function comment(settings: BoardWalkSettings, item: WorkItem, body: string): void {
  if (!settings.actions.comment) return;
  try {
    addComment({ workItemId: item.id, body: `Board walk: ${body}`, author: BOARD_WALK_ACTOR, authorKind: "system" });
  } catch (error) {
    logger.warn(`Board walk: comment on ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function release(deps: ApplyDeps, item: WorkItem, decision: TodoDecision): TickEntry {
  const entry: TickEntry = { kind: "release", workItemId: item.id, reason: decision.reason };
  if (!deps.settings.actions.release) return { ...entry, kind: "refused", outcome: "release is switched off" };
  if (item.status === "backlog") return { ...entry, outcome: "already in the queue" };
  if (item.status !== "blocked") return { ...entry, kind: "refused", outcome: `only a blocked Todo is released; this one is ${item.status}` };
  try {
    transition(item.id, "backlog", BOARD_WALK_ACTOR, { detail: { reason: "board-walk-release", note: decision.reason } });
  } catch (error) {
    return { ...entry, kind: "refused", outcome: `could not move it: ${errorText(error)}` };
  }
  comment(deps.settings, item, `released to the queue. ${decision.reason}`);
  return { ...entry, outcome: "moved to backlog" };
}

function park(deps: ApplyDeps, item: WorkItem, decision: TodoDecision): TickEntry {
  const entry: TickEntry = { kind: "park", workItemId: item.id, reason: decision.reason };
  if (!deps.settings.actions.park) return { ...entry, kind: "refused", outcome: "park is switched off" };
  const until = decision.until ? Date.parse(decision.until) : Number.NaN;
  if (!Number.isFinite(until)) return { ...entry, kind: "refused", outcome: `park needs an ISO-8601 until (got ${JSON.stringify(decision.until ?? null)})` };
  if (until <= deps.now()) return { ...entry, kind: "refused", outcome: `the park date ${decision.until} has already passed` };
  if (item.status !== "backlog" && item.status !== "blocked") {
    return { ...entry, kind: "refused", outcome: `only a backlog or blocked Todo is parked; this one is ${item.status}` };
  }
  const parkedUntil = new Date(until).toISOString();
  try {
    transition(item.id, "blocked", BOARD_WALK_ACTOR, {
      blockKind: "transient",
      stopCause: { parkedUntil, unblockHint: { what: decision.reason, who: "the clock" } },
      detail: { reason: "board-walk-park", note: decision.reason },
    });
  } catch (error) {
    return { ...entry, kind: "refused", outcome: `could not park it: ${errorText(error)}` };
  }
  comment(deps.settings, item, `parked until ${parkedUntil}; it returns to the queue by itself then. ${decision.reason}`);
  return { ...entry, outcome: `parked until ${parkedUntil}` };
}

function flag(deps: ApplyDeps, item: WorkItem, decision: TodoDecision): TickEntry {
  const entry: TickEntry = { kind: "stuck", workItemId: item.id, reason: decision.reason };
  if (!deps.settings.actions.flagStuck) return { ...entry, kind: "refused", outcome: "flagStuck is switched off" };
  const episode = stuckEpisode(item);
  if (deps.state.stuckFlags[item.id] === episode) return { ...entry, outcome: "already flagged; not raised again" };
  deps.state.stuckFlags[item.id] = episode;
  comment(deps.settings, item, `this looks stuck. ${decision.reason}`);
  return { ...entry, outcome: deps.settings.actions.comment ? "flagged with a comment" : "flagged (comments are switched off)" };
}

function applyTodo(deps: ApplyDeps, decision: TodoDecision): TickEntry {
  const item = getWorkItem(decision.id);
  if (!item) return { kind: "refused", workItemId: decision.id, reason: decision.reason, outcome: "no such Todo" };
  if (!OPEN.has(item.status)) {
    return { kind: "refused", workItemId: item.id, reason: decision.reason, outcome: `the walk only touches open Todos; this one is ${item.status}` };
  }
  switch (decision.action) {
    case "release": return release(deps, item, decision);
    case "park": return park(deps, item, decision);
    case "flag": return flag(deps, item, decision);
    case "none": return { kind: decision.verdict, workItemId: item.id, reason: decision.reason, outcome: "left alone" };
  }
}

function start(deps: ApplyDeps, decision: StartDecision): TickEntry {
  const entry: TickEntry = { kind: "dispatch", workItemId: decision.id, reason: decision.reason };
  const item = getWorkItem(decision.id);
  if (!item) return { ...entry, kind: "refused", outcome: "no such Todo" };
  if (item.status !== "backlog") return { ...entry, kind: "refused", outcome: `only a backlog Todo is started; this one is ${item.status}` };
  const optOut = noAutoStartReason(item);
  if (optOut) return { ...entry, kind: "refused", outcome: `it refuses automatic starts (${optOut})` };
  let result: StartTodoDispatcherResult;
  try {
    result = deps.dispatch(item, decision);
  } catch (error) {
    return { ...entry, kind: "refused", outcome: `the Dispatcher could not start: ${errorText(error)}` };
  }
  if (!result.ok) return { ...entry, kind: "refused", outcome: `the Dispatcher refused: ${result.body.error}` };
  if (result.body.reused) return { ...entry, kind: "refused", outcome: "a Dispatcher already holds it", sessionId: result.body.sessionId };
  comment(deps.settings, item, `started the Todo Dispatcher (session ${result.body.sessionId}). ${decision.reason}`);
  return { ...entry, outcome: "started the Todo Dispatcher", sessionId: result.body.sessionId };
}

/** Forget flags for Todos that are no longer in the episode they were flagged in. */
function pruneFlags(state: BoardWalkState): void {
  for (const id of Object.keys(state.stuckFlags)) {
    const item = getWorkItem(id);
    if (!item || !OPEN.has(item.status) || stuckEpisode(item) !== state.stuckFlags[id]) delete state.stuckFlags[id];
  }
}

export function applyDecisions(deps: ApplyDeps, decisions: WalkDecisions): TickEntry[] {
  const entries: TickEntry[] = [];
  for (const decision of decisions.todos) entries.push(applyTodo(deps, decision));

  const { start: starts, reason } = decisions.dispatch;
  if (!deps.settings.actions.dispatch) {
    entries.push({ kind: "hold", reason, outcome: "dispatch is switched off" });
    for (const decision of starts) entries.push({ kind: "refused", workItemId: decision.id, reason: decision.reason, outcome: "dispatch is switched off" });
  } else if (starts.length === 0) {
    entries.push({ kind: "hold", reason, outcome: "nothing started" });
  } else {
    for (const decision of starts) entries.push(start(deps, decision));
  }

  pruneFlags(deps.state);
  return entries;
}
