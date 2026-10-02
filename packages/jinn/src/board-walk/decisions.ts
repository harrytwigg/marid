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

/** Every fenced block in a reply, paired line by line: a fence opens on a
 *  line starting with three backticks (any info string) and closes on the next
 *  bare one. Pairing by line is what stops the closing fence of an earlier
 *  block being read as the opening of the answer. */
function fencedBlocks(reply: string): Array<{ info: string; body: string }> {
  const blocks: Array<{ info: string; body: string }> = [];
  let open: { info: string; lines: string[] } | undefined;
  for (const line of reply.split(/\r?\n/)) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (!open) {
      if (fence) open = { info: fence[1].trim().toLowerCase(), lines: [] };
    } else if (fence && fence[1].trim() === "") {
      blocks.push({ info: open.info, body: open.lines.join("\n").trim() });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  return blocks;
}

function parsesAsObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** The JSON object in a reply: the last fenced block that parses as one
 *  (a `json` block preferred), else the outermost braces of the reply. */
export function extractJson(reply: string): string | undefined {
  const blocks = fencedBlocks(reply).reverse();
  const fenced = blocks.find((block) => block.info === "json" && parsesAsObject(block.body))
    ?? blocks.find((block) => parsesAsObject(block.body));
  if (fenced) return fenced.body;
  const jsonBlock = blocks.find((block) => block.info === "json");
  if (jsonBlock) return jsonBlock.body;
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

function parseObject(reply: string): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  const json = extractJson(reply);
  if (!json) return { ok: false, error: "the reply carried no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `the reply's JSON does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  return isRecord(raw) ? { ok: true, raw } : { ok: false, error: "the reply's JSON is not an object" };
}

function listOf<T>(raw: unknown, name: string, read: (entry: unknown, index: number, problems: string[]) => T | undefined, problems: string[]): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { problems.push(`${name} is not a list`); return []; }
  return raw.map((entry, index) => read(entry, index, problems)).filter((entry): entry is T => entry !== undefined);
}

export function parseDecisions(reply: string): ParsedDecisions {
  const parsed = parseObject(reply);
  if (!parsed.ok) return parsed;
  const { raw } = parsed;
  const problems: string[] = [];
  const todos = listOf(raw.todos, "todos", todoDecision, problems);
  const dispatchRaw = isRecord(raw.dispatch) ? raw.dispatch : {};
  const start = listOf(dispatchRaw.start, "dispatch.start", startDecision, problems);
  const dispatchReason = text(dispatchRaw.reason);
  if (!dispatchReason) return { ok: false, error: "the reply gives no dispatch.reason (why it starts something, or why nothing)" };
  const summary = text(raw.summary) ?? dispatchReason;
  return { ok: true, decisions: { todos, dispatch: { start, reason: dispatchReason }, summary }, problems };
}
