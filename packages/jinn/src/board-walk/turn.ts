import { getWorkItem } from "../work-items/store.js";
import { digestTodo, listOpenTodos, OPEN_STATUSES } from "./board.js";
import { boardLine, renderTodo } from "./board-render.js";
import { readStartDecision, readTodoDecision } from "./decisions.js";
import { applyTodo, pruneFlags, startTodo, type ApplyDeps } from "./apply.js";
import type { TickEntry } from "./store.js";

/**
 * The gateway's end of the walk's tools (mcp/board-walk-tools.ts): one live
 * walk turn, the reads it may make and the decisions it may hand over.
 *
 * The model goes through the board one Todo at a time. Each decision is read
 * on its own, checked and carried out at once by apply.ts, and its outcome
 * goes straight back to the model; one that cannot be read or is refused
 * changes nothing and may be made again. A Todo decided and carried out is
 * not decided twice in one tick. Every call counts against the tick's budget,
 * so a large board cannot run a turn on without end.
 */

export const WALK_TOOLS = ["walk_board", "walk_todo", "walk_decide", "walk_start", "walk_finish"] as const;
export type WalkToolName = (typeof WALK_TOOLS)[number];

export interface WalkToolResult {
  /** False: the call was refused or could not be read. The text says why. */
  ok: boolean;
  text: string;
}

export interface WalkTurnOptions {
  apply: ApplyDeps;
  /** Todo ids whose current stuck episode is already flagged. */
  flagged: ReadonlySet<string>;
  /** The open Todos when the tick began: each is owed a decision. */
  openIds: readonly string[];
  maxCalls: number;
}

const BOARD_PAGE = 50;
const OPEN = new Set<string>(OPEN_STATUSES);

/** A tool call's budget: three calls a Todo (a read, a decision, a retry)
 *  and some for paging the board and finishing, within a hard ceiling. */
export function walkCallBudget(openTodos: number): number {
  return Math.min(600, openTodos * 3 + 20);
}

const integer = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;

export class WalkTools {
  /** Per Todo: what the gateway did with its decision. */
  private readonly decided = new Map<string, TickEntry>();
  private readonly refused: TickEntry[] = [];
  private readonly starts: TickEntry[] = [];
  private finish?: { summary: string; dispatchReason: string };
  private calls = 0;
  private closed = false;

  constructor(private readonly opts: WalkTurnOptions) {}

  /** No call is taken after this: the tick is over, or has given up on the turn. */
  close(): void {
    this.closed = true;
  }

  /** Decisions and starts the gateway carried out this tick. */
  get carriedOut(): number {
    return this.decided.size + this.starts.length;
  }

  get modelSummary(): string | undefined {
    return this.finish?.summary;
  }

  async call(name: string, args: Record<string, unknown>): Promise<WalkToolResult> {
    if (this.closed) return { ok: false, text: "this tick is over; nothing more is taken from this turn" };
    if (this.finish) return { ok: false, text: "you already finished this tick; stop now" };
    this.calls += 1;
    if (this.calls > this.opts.maxCalls) {
      return { ok: false, text: `this tick's budget of ${this.opts.maxCalls} tool calls is spent: call nothing more. Anything not decided waits for the next tick.` };
    }
    switch (name as WalkToolName) {
      case "walk_board": return this.board(args);
      case "walk_todo": return this.todo(args);
      case "walk_decide": return this.decide(args);
      case "walk_start": return this.start(args);
      case "walk_finish": return this.finishTick(args);
      default: return { ok: false, text: `there is no walk tool ${JSON.stringify(name)}` };
    }
  }

  private board(args: Record<string, unknown>): WalkToolResult {
    const open = listOpenTodos();
    const offset = integer(args.offset, 0);
    const page = open.slice(offset, offset + Math.min(integer(args.limit, BOARD_PAGE) || BOARD_PAGE, 100));
    const lines = page.map((item) => boardLine(item, { flagged: this.opts.flagged.has(item.id), decided: this.decided.get(item.id)?.outcome }));
    const decided = open.filter((item) => this.decided.has(item.id)).length;
    const head = `${open.length} open Todo${open.length === 1 ? "" : "s"}, ${decided} decided this tick; showing ${page.length === 0 ? "none" : `${offset + 1}–${offset + page.length}`}.`;
    const more = offset + page.length < open.length ? `\nMore: call walk_board with offset ${offset + page.length}.` : "";
    return { ok: true, text: [head, ...lines].join("\n") + more };
  }

  private async todo(args: Record<string, unknown>): Promise<WalkToolResult> {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const item = id ? getWorkItem(id) : undefined;
    if (!item) return { ok: false, text: `there is no Todo ${JSON.stringify(id)}` };
    if (!OPEN.has(item.status)) return { ok: false, text: `${item.id} is ${item.status}; the walk only handles open Todos` };
    const todo = await digestTodo(item, { resolveLink: this.opts.apply.resolveLink, flagged: this.opts.flagged });
    const decided = this.decided.get(item.id);
    return { ok: true, text: renderTodo(todo) + (decided ? `\nDECIDED this tick: ${decided.outcome}` : "") };
  }

  private async decide(args: Record<string, unknown>): Promise<WalkToolResult> {
    const read = readTodoDecision(args);
    if (!read.ok) return this.refuse({ kind: "refused", reason: "unreadable decision", outcome: read.problem, ...(typeof args.id === "string" ? { workItemId: args.id } : {}) });
    const { decision } = read;
    const earlier = this.decided.get(decision.id);
    if (earlier) return { ok: false, text: `${decision.id} is already decided this tick: ${earlier.outcome}` };
    const entry = await applyTodo(this.opts.apply, decision);
    if (entry.kind === "refused") return this.refuse(entry);
    this.decided.set(decision.id, entry);
    return { ok: true, text: `${decision.id}: ${entry.outcome}` };
  }

  private start(args: Record<string, unknown>): WalkToolResult {
    const read = readStartDecision(args);
    if (!read.ok) return this.refuse({ kind: "refused", reason: "unreadable start", outcome: read.problem });
    if (this.starts.some((entry) => entry.workItemId === read.decision.id)) return { ok: false, text: `${read.decision.id} was already started this tick` };
    const entry = startTodo(this.opts.apply, read.decision);
    if (entry.kind === "refused") return this.refuse(entry);
    this.starts.push(entry);
    return { ok: true, text: `${read.decision.id}: ${entry.outcome}` };
  }

  private finishTick(args: Record<string, unknown>): WalkToolResult {
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    const dispatchReason = typeof args.dispatchReason === "string" ? args.dispatchReason.trim() : "";
    if (!summary || !dispatchReason) return { ok: false, text: "walk_finish needs a summary and a dispatchReason" };
    this.finish = { summary, dispatchReason };
    return { ok: true, text: "Recorded. The tick is done: stop now." };
  }

  /** Logged, and handed back to the model to correct: it changes nothing. */
  private refuse(entry: TickEntry): WalkToolResult {
    this.refused.push(entry);
    return { ok: false, text: `refused${entry.workItemId ? ` for ${entry.workItemId}` : ""}: ${entry.outcome}. Nothing changed; you may decide again.` };
  }

  /**
   * What the tick log records. First one entry per open Todo, in board order:
   * the decision carried out, else the last refusal it got, else that it got
   * no decision. Then any decision on a Todo that opened mid-tick, and the
   * refusals not already shown; last, the starts, or why nothing was started.
   */
  entries(): TickEntry[] {
    const owed = new Set(this.opts.openIds);
    const lastRefusal = new Map<string, TickEntry>();
    for (const entry of this.refused) if (entry.workItemId) lastRefusal.set(entry.workItemId, entry);
    const perTodo = this.opts.openIds.map((id): TickEntry => this.decided.get(id) ?? lastRefusal.get(id)
      ?? { kind: "undecided", workItemId: id, reason: "no decision was made on it this tick", outcome: "left as it was" });
    const shown = new Set(perTodo);
    const decisions = [
      ...perTodo,
      ...[...this.decided].filter(([id]) => !owed.has(id)).map(([, entry]) => entry),
      ...this.refused.filter((entry) => !shown.has(entry)),
    ];
    const dispatchReason = this.finish?.dispatchReason ?? "the walk gave no reason: it did not finish the tick";
    const dispatch = this.starts.length > 0
      ? this.starts
      : [{ kind: "hold", reason: dispatchReason, outcome: this.opts.apply.settings.actions.dispatch ? "nothing started" : "dispatch is switched off" } satisfies TickEntry];
    pruneFlags(this.opts.apply.state);
    return [...decisions, ...dispatch];
  }

  /** Why the starts are what they are, as the model put it. */
  get dispatchReason(): string | undefined {
    return this.finish?.dispatchReason;
  }
}
