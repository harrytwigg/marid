import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { OPERATOR_ASSIGNEE } from "../work-items/assignment.js";
import { readStopCause } from "../work-items/stop-cause.js";
import { readBlockRecord } from "../work-items/blocks.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { transition } from "../work-items/transitions.js";
import { addComment } from "../work-items/comment-add.js";
import type { StartTodoDispatcherResult } from "../gateway/todo-dispatch.js";
import type { BoardWalkSettings } from "./settings.js";
import type { Gate, StartDecision, TodoDecision } from "./decisions.js";
import { findLinks, type LinkResolver } from "./pr-state.js";
import { UNROUTED, type WalkAccounts } from "./accounts.js";
import { namesDate } from "./dates.js";
import { startDateHold } from "../work-items/start-date.js";
import { listComments } from "../work-items/comments.js";
import { listRelations } from "../work-items/relations.js";
import { listWorkItemEvents } from "../work-items/event-log.js";
import { OPEN_STATUSES, noAutoStartReason, statusSince } from "./board.js";
import type { BoardWalkState, TickEntry } from "./store.js";

/**
 * Carry out the walk's decisions, each one as it is made. The model proposes;
 * this module disposes:
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
  /** Re-checks a cited pull request or issue at release time. */
  resolveLink: LinkResolver;
  /** The tick's accounts: a start on an account recorded at its limit is refused in code (FR-075). */
  accounts?: WalkAccounts;
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

/** Whether the Todo's current stop is an approval carried over from the
 *  retired approvals feature: a question a person was asked and has not
 *  answered (work-items/retired-approvals.ts). */
function heldByRetiredApproval(item: WorkItem): boolean {
  const events = listWorkItemEvents(item.id);
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind !== "status_change") continue;
    return events[i].toStatus === item.status && events[i].detail?.reason === "retired-approval";
  }
  return false;
}

/** Why a Todo is the operator's to move, or undefined. A Todo assigned to the
 *  operator, stopped with the operator named as who must act, or holding an
 *  approval question carried over from the retired approvals, is waiting on a
 *  person's decision: the walk may flag it, never release or park it. */
export function operatorGate(item: WorkItem): string | undefined {
  if (item.assignee === OPERATOR_ASSIGNEE) return "it is assigned to the operator";
  const hint = readStopCause(initDb(), item.id)?.unblockHint;
  if (hint && /\boperator\b/i.test(hint.who)) return `it waits on ${hint.who} (${hint.what})`;
  if (item.status === "blocked" && heldByRetiredApproval(item)) return `it holds an unanswered approval question${hint ? ` for ${hint.who}` : ""}`;
  return undefined;
}

/** Everything a Todo says, where a gate can be named: title, body and
 *  every comment except the walk's own, which would let one
 *  tick's words become the next tick's evidence. */
function todoText(item: WorkItem): string[] {
  const comments = listComments(item.id, { limit: 500 }).comments.filter((comment) => comment.author !== BOARD_WALK_ACTOR);
  return [item.title, item.body ?? "", ...comments.map((comment) => comment.body)];
}

const normalised = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

/** A date gate holds only when the Todo itself names it: the quote must be
 *  the Todo's own words, found in its text, and those words must name the
 *  cited date — so a past date picked from nowhere, or a quote that names some
 *  other day, cannot release a Todo that is waiting on something else. */
function dateProblem(gate: Extract<Gate, { kind: "date" }>, now: number, text: string[]): string | undefined {
  const quote = normalised(gate.quote);
  if (quote.length < 4 || !text.some((part) => normalised(part).includes(quote))) {
    return `the quoted words "${gate.quote}" are not in this Todo, so the date gate is not its own`;
  }
  if (!namesDate(gate.quote, gate.date)) return `the quoted words "${gate.quote}" do not name ${gate.date}`;
  const at = Date.parse(gate.date);
  if (!Number.isFinite(at)) return `the date ${gate.date} does not parse`;
  return at <= now ? undefined : `the date ${gate.date} has not passed`;
}

function blockerProblem(item: WorkItem, id: string, text: string[]): string | undefined {
  const blocker = getWorkItem(id);
  if (!blocker) return `blocker ${id} does not exist`;
  const related = listRelations(item.id).some((relation) => relation.kind === "blocks" && relation.direction === "in" && relation.other.id === blocker.id);
  if (!related && !text.some((part) => part.includes(blocker.id))) return `${blocker.id} is not a blocker this Todo names`;
  return blocker.status === "done" ? undefined : `blocker ${blocker.id} is ${blocker.status}, not done`;
}

async function linkProblem(gate: Extract<Gate, { url: string }>, deps: ApplyDeps, text: string[]): Promise<string | undefined> {
  if (!findLinks(text, 100).some((link) => link.url === gate.url)) return `${gate.url} is not linked from this Todo`;
  const state = await deps.resolveLink(gate.url, gate.kind === "pr" ? "pull" : "issue");
  const met = gate.kind === "pr" ? state.state === "MERGED" : state.state === "CLOSED" || state.state === "MERGED";
  return met ? undefined : `${gate.url} is ${state.state}${state.error ? ` (${state.error})` : ""}`;
}

/** Why a cited gate is not met, or undefined when the gateway confirms it. */
function gateProblem(item: WorkItem, gate: Gate, deps: ApplyDeps, text: string[]): Promise<string | undefined> | string | undefined {
  if (gate.kind === "date") return dateProblem(gate, deps.now(), text);
  if (gate.kind === "blocker") return blockerProblem(item, gate.id, text);
  return linkProblem(gate, deps, text);
}

/** Every cited gate checked by the gateway itself; the model's word is not
 *  enough to move a Todo out of `blocked`. */
async function unmetGate(item: WorkItem, gates: Gate[] | undefined, deps: ApplyDeps): Promise<string | undefined> {
  if (!gates || gates.length === 0) return "a release must cite the gates that are met (a date, a blocker or a pull request), so the gateway can check them";
  const text = todoText(item);
  for (const gate of gates) {
    const problem = await gateProblem(item, gate, deps, text);
    if (problem) return problem;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function release(deps: ApplyDeps, item: WorkItem, decision: TodoDecision): Promise<TickEntry> {
  const entry: TickEntry = { kind: "release", workItemId: item.id, reason: decision.reason };
  if (!deps.settings.actions.release) return { ...entry, kind: "refused", outcome: "release is switched off" };
  if (item.status === "backlog") return { ...entry, outcome: "already in the queue" };
  const gate = operatorGate(item);
  if (gate) return { ...entry, kind: "refused", outcome: `only the operator releases it: ${gate}` };
  const unmet = await unmetGate(item, decision.gates, deps);
  if (unmet) return { ...entry, kind: "refused", outcome: `gate not confirmed: ${unmet}` };
  if (item.status !== "blocked") return { ...entry, kind: "refused", outcome: `only a blocked Todo is released; this one is ${item.status}` };
  try {
    transition(item.id, "backlog", BOARD_WALK_ACTOR, { detail: { reason: "board-walk-release", note: decision.reason } });
  } catch (error) {
    return { ...entry, kind: "refused", outcome: `could not move it: ${errorText(error)}` };
  }
  comment(deps.settings, item, `released to the queue. ${decision.reason}`);
  return { ...entry, outcome: "moved to backlog" };
}

/** The park date, or why the decision names none that can be used. */
function parkDate(decision: TodoDecision, now: number): { refused: string } | { parkedUntil: string } {
  const until = decision.until ? Date.parse(decision.until) : Number.NaN;
  if (!Number.isFinite(until)) return { refused: `park needs an ISO-8601 until (got ${JSON.stringify(decision.until ?? null)})` };
  if (until <= now) return { refused: `the park date ${decision.until} has already passed` };
  return { parkedUntil: new Date(until).toISOString() };
}

/** Why this Todo may not be parked, or undefined. A park releases itself on
 *  its date. On a Todo stopped for a person that would dissolve the wait, so
 *  only a clock-wait (a park or a transient stop) is re-parked; anything else
 *  stays as it is, for release when its gate is met. */
function parkRefusal(item: WorkItem): string | undefined {
  if (item.status !== "backlog" && item.status !== "blocked") return `only a backlog or blocked Todo is parked; this one is ${item.status}`;
  const gate = operatorGate(item);
  if (gate) return `only the operator parks it: ${gate}`;
  if (item.status !== "blocked") return undefined;
  const kind = readBlockRecord(initDb(), item.id)?.kind ?? "needs_input";
  return kind === "transient" ? undefined : `it is stopped for a person (${kind}); a park would release it on the date`;
}

/** Why a park cannot go ahead, or the date it parks until. */
function parkPlan(deps: ApplyDeps, item: WorkItem, decision: TodoDecision): { refused: string } | { parkedUntil: string } {
  if (!deps.settings.actions.park) return { refused: "park is switched off" };
  const date = parkDate(decision, deps.now());
  if ("refused" in date) return date;
  const refused = parkRefusal(item);
  return refused ? { refused } : date;
}

function park(deps: ApplyDeps, item: WorkItem, decision: TodoDecision): TickEntry {
  const entry: TickEntry = { kind: "park", workItemId: item.id, reason: decision.reason };
  const plan = parkPlan(deps, item, decision);
  if ("refused" in plan) return { ...entry, kind: "refused", outcome: plan.refused };
  const { parkedUntil } = plan;
  // A Todo already stopped keeps the hint it was stopped with: the park adds a
  // date to that wait, it does not rewrite who the wait is on.
  const hint = item.status === "blocked" ? readStopCause(initDb(), item.id)?.unblockHint : undefined;
  try {
    transition(item.id, "blocked", BOARD_WALK_ACTOR, {
      blockKind: "transient",
      stopCause: { parkedUntil, unblockHint: hint ?? { what: decision.reason, who: "the clock" } },
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

/** One Todo decision, checked against the Todo as it is now and carried out. */
export async function applyTodo(deps: ApplyDeps, decision: TodoDecision): Promise<TickEntry> {
  const item = getWorkItem(decision.id);
  if (!item) return { kind: "refused", workItemId: decision.id, reason: decision.reason, outcome: "no such Todo" };
  if (!OPEN.has(item.status)) {
    return { kind: "refused", workItemId: item.id, reason: decision.reason, outcome: `the walk only touches open Todos; this one is ${item.status}` };
  }
  switch (decision.action) {
    case "release": return release(deps, item, decision);
    case "park": return park(deps, item, decision);
    case "flag": return flag(deps, item, decision);
    case "leave": return { kind: decision.verdict, workItemId: item.id, reason: decision.reason, outcome: "left alone" };
  }
}

/** Why a start must not go ahead because its account is at its limit, or undefined. */
function exhaustedAccountRefusal(accounts: WalkAccounts | undefined, item: WorkItem): string | undefined {
  if (!accounts) return undefined;
  const account = accounts.of(item);
  if (!accounts.exhausted(account)) return undefined;
  return account === UNROUTED
    ? "it is unassigned, so it is judged against the default Claude account, which is recorded at its limit"
    : `the account it would run on (${accounts.label(account)}) is recorded at its limit`;
}

/** One start, through the Todo Dispatcher, unless the switch, the Todo or its account refuses it. */
export function startTodo(deps: ApplyDeps, decision: StartDecision): TickEntry {
  const entry: TickEntry = { kind: "dispatch", workItemId: decision.id, reason: decision.reason };
  if (!deps.settings.actions.dispatch) return { ...entry, kind: "refused", outcome: "dispatch is switched off" };
  const item = getWorkItem(decision.id);
  if (!item) return { ...entry, kind: "refused", outcome: "no such Todo" };
  if (item.status !== "backlog") return { ...entry, kind: "refused", outcome: `only a backlog Todo is started; this one is ${item.status}` };
  const optOut = noAutoStartReason(item);
  if (optOut) return { ...entry, kind: "refused", outcome: `it refuses automatic starts (${optOut})` };
  if (startDateHold(item, deps.now())) return { ...entry, kind: "refused", outcome: `it is held until its start date, ${item.startAt}` };
  const limited = exhaustedAccountRefusal(deps.accounts, item);
  if (limited) return { ...entry, kind: "refused", outcome: limited };
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
export function pruneFlags(state: BoardWalkState): void {
  for (const id of Object.keys(state.stuckFlags)) {
    const item = getWorkItem(id);
    if (!item || !OPEN.has(item.status) || stuckEpisode(item) !== state.stuckFlags[id]) delete state.stuckFlags[id];
  }
}
