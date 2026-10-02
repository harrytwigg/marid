/**
 * What the walk's model answers with, and how that answer is read.
 *
 * The model does not act. It returns one JSON object; the gateway validates it
 * and carries it out (apply.ts), so every act is checked against the switches,
 * the Todo's real state and its opt-outs, and lands in the tick log with the
 * model's own reason. A reply that cannot be read is a failed tick that does
 * nothing, never a partial guess.
 */

export const VERDICTS = ["ready", "gated", "stuck", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const TODO_ACTIONS = ["release", "park", "flag", "none"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];

export interface TodoDecision {
  id: string;
  verdict: Verdict;
  action: TodoAction;
  reason: string;
  /** For `park`: when the gate opens (ISO-8601). */
  until?: string;
}

export interface StartDecision {
  id: string;
  reason: string;
  /** A preference passed on to the Dispatcher, not an override. */
  engine?: string;
  model?: string;
}

export interface WalkDecisions {
  todos: TodoDecision[];
  dispatch: { start: StartDecision[]; reason: string };
  summary: string;
}

export type ParsedDecisions =
  | { ok: true; decisions: WalkDecisions; problems: string[] }
  | { ok: false; error: string };

/** The JSON object in a reply: the last fenced ```json block, else the
 *  outermost braces. */
export function extractJson(reply: string): string | undefined {
  const fences = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (fences.length > 0) return fences[fences.length - 1][1].trim();
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  return start !== -1 && end > start ? reply.slice(start, end + 1) : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function todoDecision(raw: unknown, index: number, problems: string[]): TodoDecision | undefined {
  if (!isRecord(raw)) { problems.push(`todos[${index}] is not an object`); return undefined; }
  const id = text(raw.id);
  const reason = text(raw.reason);
  const verdict = raw.verdict as Verdict;
  const action = (raw.action ?? "none") as TodoAction;
  if (!id) { problems.push(`todos[${index}] has no id`); return undefined; }
  if (!VERDICTS.includes(verdict)) { problems.push(`todos[${index}] (${id}) has verdict ${JSON.stringify(raw.verdict)}; expected ${VERDICTS.join(", ")}`); return undefined; }
  if (!TODO_ACTIONS.includes(action)) { problems.push(`todos[${index}] (${id}) has action ${JSON.stringify(raw.action)}; expected ${TODO_ACTIONS.join(", ")}`); return undefined; }
  if (!reason) { problems.push(`todos[${index}] (${id}) gives no reason`); return undefined; }
  const until = text(raw.until);
  return { id, verdict, action, reason, ...(until ? { until } : {}) };
}

function startDecision(raw: unknown, index: number, problems: string[]): StartDecision | undefined {
  if (!isRecord(raw)) { problems.push(`dispatch.start[${index}] is not an object`); return undefined; }
  const id = text(raw.id);
  const reason = text(raw.reason);
  if (!id || !reason) { problems.push(`dispatch.start[${index}] needs an id and a reason`); return undefined; }
  const engine = text(raw.engine);
  const model = text(raw.model);
  return { id, reason, ...(engine ? { engine } : {}), ...(model ? { model } : {}) };
}

export function parseDecisions(reply: string): ParsedDecisions {
  const json = extractJson(reply);
  if (!json) return { ok: false, error: "the reply carried no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `the reply's JSON does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(raw)) return { ok: false, error: "the reply's JSON is not an object" };
  const problems: string[] = [];
  const todos = (Array.isArray(raw.todos) ? raw.todos : [])
    .map((entry, index) => todoDecision(entry, index, problems))
    .filter((entry): entry is TodoDecision => entry !== undefined);
  if (raw.todos !== undefined && !Array.isArray(raw.todos)) problems.push("todos is not a list");
  const dispatchRaw = isRecord(raw.dispatch) ? raw.dispatch : {};
  const start = (Array.isArray(dispatchRaw.start) ? dispatchRaw.start : [])
    .map((entry, index) => startDecision(entry, index, problems))
    .filter((entry): entry is StartDecision => entry !== undefined);
  const dispatchReason = text(dispatchRaw.reason);
  if (!dispatchReason) return { ok: false, error: "the reply gives no dispatch.reason (why it starts something, or why nothing)" };
  const summary = text(raw.summary) ?? dispatchReason;
  return { ok: true, decisions: { todos, dispatch: { start, reason: dispatchReason }, summary }, problems };
}
