/**
 * What the walk's model decides, one Todo at a time, and how each decision is
 * read.
 *
 * The model does not act. It hands the gateway one decision per tool call
 * (board-walk/turn.ts); each is read here on its own, and a decision that
 * cannot be read is refused for that Todo alone, with the reason, so the
 * model can correct it. The gateway then checks and carries it out (apply.ts).
 */

export const VERDICTS = ["ready", "gated", "stuck", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const TODO_ACTIONS = ["release", "park", "flag", "leave"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];

/** A gate the gateway can check for itself. A release must cite every gate
 *  it relies on, and each one is verified before the Todo moves. */
export type Gate =
  | { kind: "date"; date: string; quote: string }
  | { kind: "blocker"; id: string }
  | { kind: "pr" | "issue"; url: string };

export interface TodoDecision {
  id: string;
  verdict: Verdict;
  action: TodoAction;
  reason: string;
  /** For `park`: when the gate opens (ISO-8601). */
  until?: string;
  /** For `release`: the gates that are now met. */
  gates?: Gate[];
}

export interface StartDecision {
  id: string;
  reason: string;
  /** A preference passed on to the Dispatcher, not an override. */
  engine?: string;
  model?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function gate(raw: unknown): Gate | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "date" && text(raw.date) && text(raw.quote)) return { kind: "date", date: text(raw.date)!, quote: text(raw.quote)! };
  if (raw.kind === "blocker" && text(raw.id)) return { kind: "blocker", id: text(raw.id)! };
  if ((raw.kind === "pr" || raw.kind === "issue") && text(raw.url)) return { kind: raw.kind, url: text(raw.url)! };
  return undefined;
}

function gatesOf(raw: unknown, problems: string[]): Gate[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : [];
  const gates = list.map(gate);
  if (!Array.isArray(raw) || gates.some((entry) => entry === undefined)) {
    problems.push("some gates cannot be read; each is {kind: date, date, quote} | {kind: blocker, id} | {kind: pr|issue, url}");
  }
  return gates.filter((entry): entry is Gate => entry !== undefined);
}

export type Read<T> = { ok: true; decision: T } | { ok: false; problem: string };

/** One Todo decision, or why it cannot be used. */
export function readTodoDecision(raw: unknown): Read<TodoDecision> {
  if (!isRecord(raw)) return { ok: false, problem: "the decision is not an object" };
  const id = text(raw.id);
  const reason = text(raw.reason);
  const verdict = raw.verdict as Verdict;
  const action = raw.action as TodoAction;
  if (!id) return { ok: false, problem: "the decision names no Todo id" };
  if (!VERDICTS.includes(verdict)) return { ok: false, problem: `verdict ${JSON.stringify(raw.verdict)} is not one of ${VERDICTS.join(", ")}` };
  if (!TODO_ACTIONS.includes(action)) return { ok: false, problem: `action ${JSON.stringify(raw.action)} is not one of ${TODO_ACTIONS.join(", ")}` };
  if (!reason) return { ok: false, problem: "the decision gives no reason" };
  const problems: string[] = [];
  const until = text(raw.until);
  const gates = gatesOf(raw.gates, problems);
  if (problems.length > 0) return { ok: false, problem: problems.join("; ") };
  return { ok: true, decision: { id, verdict, action, reason, ...(until ? { until } : {}), ...(gates ? { gates } : {}) } };
}

/** One start, or why it cannot be used. */
export function readStartDecision(raw: unknown): Read<StartDecision> {
  if (!isRecord(raw)) return { ok: false, problem: "the start is not an object" };
  const id = text(raw.id);
  const reason = text(raw.reason);
  if (!id || !reason) return { ok: false, problem: "a start needs a Todo id and a reason" };
  const engine = text(raw.engine);
  const model = text(raw.model);
  return { ok: true, decision: { id, reason, ...(engine ? { engine } : {}), ...(model ? { model } : {}) } };
}
