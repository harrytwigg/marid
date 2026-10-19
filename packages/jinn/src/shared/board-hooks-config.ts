/**
 * The `hooks` block of config.yaml: configurable reactions to Todo board events
 * (docs/board-hooks.md). Validation lives here, beside the other config blocks;
 * the runtime in `board-hooks/` reads only hooks that pass it.
 */

export const BOARD_HOOK_EVENTS = [
  "todo.created",
  "todo.status_changed",
  "todo.assigned",
  "todo.delegated",
  "todo.dispatched",
  "todo.commented",
] as const;
export type BoardHookEvent = (typeof BOARD_HOOK_EVENTS)[number];

/** A Todo status, as `match.from` / `match.to` name it. */
const HOOK_STATUSES: ReadonlySet<string> = new Set(["backlog", "executing", "in_review", "blocked", "done", "cancelled"]);
const HOOK_NAME = /^[a-z0-9-]{1,64}$/;
const MATCH_FIELDS = ["from", "to", "department", "label", "assignee", "actor"] as const;
const ACTION_KINDS = ["spawn", "command", "notify"] as const;

export interface BoardHookMatch {
  from?: string | string[];
  to?: string | string[];
  department?: string | string[];
  label?: string | string[];
  assignee?: string | string[];
  actor?: string | string[];
}

export interface BoardHookSpawn {
  employee: string;
  prompt?: string;
  effortLevel?: string;
  engine?: string;
  model?: string;
}

export interface BoardHookCommand {
  run: string;
  cwd?: string;
}

export interface BoardHookNotify {
  connector: string;
  channel: string | number;
  thread?: string | number | null;
  text: string;
}

export interface BoardHookConfig {
  name: string;
  enabled?: boolean;
  event: BoardHookEvent | BoardHookEvent[];
  match?: BoardHookMatch;
  allowReentry?: boolean;
  action: { spawn?: BoardHookSpawn; command?: BoardHookCommand; notify?: BoardHookNotify };
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** One value or a non-empty list of them, each a non-empty string. */
function isStringOrList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(isNonEmptyString);
  return isNonEmptyString(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function eventProblems(event: unknown): string[] {
  if (!isStringOrList(event)) return ["event must be an event name or a list of them"];
  const unknown = asList(event).filter((name) => !(BOARD_HOOK_EVENTS as readonly string[]).includes(name as string));
  return unknown.length === 0 ? [] : [`unknown event ${unknown.map((name) => JSON.stringify(name)).join(", ")} (known: ${BOARD_HOOK_EVENTS.join(", ")})`];
}

function matchProblems(match: unknown): string[] {
  if (match === undefined || match === null) return [];
  if (!isMapping(match)) return ["match must be a mapping"];
  const problems: string[] = [];
  for (const key of Object.keys(match)) {
    if (!(MATCH_FIELDS as readonly string[]).includes(key)) problems.push(`match.${key} is not a match field (${MATCH_FIELDS.join(", ")})`);
    else if (!isStringOrList(match[key])) problems.push(`match.${key} must be a string or a list of strings`);
  }
  for (const key of ["from", "to"] as const) {
    if (!isStringOrList(match[key])) continue;
    const bad = asList(match[key]).filter((status) => !HOOK_STATUSES.has(status as string));
    if (bad.length > 0) problems.push(`match.${key} names an unknown status ${bad.map((status) => JSON.stringify(status)).join(", ")}`);
  }
  return problems;
}

function requireStrings(owner: string, block: Mapping, keys: readonly string[]): string[] {
  return keys.filter((key) => !isNonEmptyString(block[key])).map((key) => `${owner}.${key} is required`);
}

function optionalStrings(owner: string, block: Mapping, keys: readonly string[]): string[] {
  return keys.filter((key) => block[key] !== undefined && typeof block[key] !== "string").map((key) => `${owner}.${key} must be a string`);
}

function notifyProblems(notify: Mapping): string[] {
  const problems = requireStrings("action.notify", notify, ["connector", "text"]);
  const id = (key: string) => typeof notify[key] === "string" ? notify[key] !== "" : typeof notify[key] === "number";
  if (!id("channel")) problems.push("action.notify.channel is required");
  if (notify.thread !== undefined && notify.thread !== null && typeof notify.thread !== "string" && typeof notify.thread !== "number") {
    problems.push("action.notify.thread must be a string");
  }
  return problems;
}

function actionBlockProblems(kind: (typeof ACTION_KINDS)[number], block: Mapping): string[] {
  if (kind === "spawn") {
    return [
      ...requireStrings("action.spawn", block, ["employee"]),
      ...optionalStrings("action.spawn", block, ["prompt", "effortLevel", "engine", "model"]),
    ];
  }
  if (kind === "command") return [...requireStrings("action.command", block, ["run"]), ...optionalStrings("action.command", block, ["cwd"])];
  return notifyProblems(block);
}

function actionProblems(action: unknown): string[] {
  if (!isMapping(action)) return ["action must be a mapping with at least one of spawn, command, notify"];
  const problems = Object.keys(action)
    .filter((key) => !(ACTION_KINDS as readonly string[]).includes(key))
    .map((key) => `action.${key} is not an action (${ACTION_KINDS.join(", ")})`);
  const present = ACTION_KINDS.filter((kind) => action[kind] !== undefined && action[kind] !== null);
  if (present.length === 0) problems.push("action needs at least one of spawn, command, notify");
  for (const kind of present) {
    const block = action[kind];
    if (isMapping(block)) problems.push(...actionBlockProblems(kind, block));
    else problems.push(`action.${kind} must be a mapping`);
  }
  return problems;
}

function nameProblems(name: unknown): string[] {
  if (typeof name !== "string" || !HOOK_NAME.test(name)) return ["name must be 1-64 characters of a-z, 0-9 and -"];
  return [];
}

/** What is wrong with one hook, without its position or name. */
export function hookProblems(hook: unknown): string[] {
  if (!isMapping(hook)) return ["must be a mapping"];
  const problems = [...nameProblems(hook.name), ...eventProblems(hook.event), ...matchProblems(hook.match), ...actionProblems(hook.action)];
  for (const key of ["enabled", "allowReentry"]) {
    if (hook[key] !== undefined && typeof hook[key] !== "boolean") problems.push(`${key} must be true or false`);
  }
  return problems;
}

function label(hook: unknown, index: number): string {
  const name = isMapping(hook) && typeof hook.name === "string" && hook.name ? ` (${hook.name})` : "";
  return `hooks[${index}]${name}`;
}

/** Indexes of the hooks that will run: valid, and the first to claim their name. */
function runnableIndexes(hooks: unknown[]): number[] {
  const seen = new Set<string>();
  const indexes: number[] = [];
  hooks.forEach((hook, index) => {
    if (hookProblems(hook).length > 0) return;
    const name = (hook as BoardHookConfig).name;
    if (seen.has(name)) return;
    seen.add(name);
    indexes.push(index);
  });
  return indexes;
}

/** Shape-check the `hooks` block. A bad hook is a problem here and is skipped at runtime; the rest still run. */
export function hooksProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return ["hooks must be a list"];
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((hook, index) => {
    for (const problem of hookProblems(hook)) problems.push(`${label(hook, index)}: ${problem}`);
    const name = isMapping(hook) ? hook.name : undefined;
    if (typeof name === "string" && HOOK_NAME.test(name)) {
      if (seen.has(name)) problems.push(`${label(hook, index)}: duplicate hook name (the first one wins)`);
      seen.add(name);
    }
  });
  return problems;
}

export interface ConfiguredHook {
  hook: BoardHookConfig;
  /** Position in `config.hooks`, which is where an `enabled` edit lands. */
  index: number;
}

/** The hooks that can run, in file order, with their positions. */
export function runnableHooks(config: { hooks?: unknown }): ConfiguredHook[] {
  const hooks = config.hooks;
  if (!Array.isArray(hooks)) return [];
  return runnableIndexes(hooks).map((index) => ({ hook: hooks[index] as BoardHookConfig, index }));
}

/** The events a hook subscribes to, as a list. */
export function hookEvents(hook: Pick<BoardHookConfig, "event">): BoardHookEvent[] {
  return Array.isArray(hook.event) ? hook.event : [hook.event];
}
