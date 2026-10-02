import { JinnMcpToolError } from "./toolkit.js";
import { parseTodoId } from "../work-items/id.js";
import { TODO_SKILLS_MAX } from "../work-items/dispatch-config.js";
import { retiredTodoFieldError } from "../work-items/retired-fields.js";

/**
 * Argument validation for the Todo tools: the shape checks every handler runs
 * before it touches the gateway.
 *
 * Each one fails with a message that names the field and says what would be
 * accepted, because the caller is a model reading the error and retrying — a
 * bare "invalid input" costs a whole round trip to learn nothing.
 */

export const FILTER_CHAR_CAP = 256;
export const WORK_ITEM_LABELS_MAX = 100;
export const RELATION_KINDS = ["blocks", "relates", "duplicates"] as const;

export function assertLength(name: string, value: string, max: number): void {
  if (value.length > max) {
    throw new JinnMcpToolError(`${name} is too long (${value.length} chars, max ${max}) — shorten it and try again`);
  }
}

export function requireString(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string {
  const v = args[name];
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new JinnMcpToolError(`${name} is required and must be a non-empty string`);
  assertLength(name, s, max);
  return s;
}

export function requireTodoId(args: Record<string, unknown>): string {
  try {
    return parseTodoId(args.id);
  } catch {
    throw new JinnMcpToolError("id must be a canonical Todo ID such as ACM-42");
  }
}

export function requireTodoIdField(args: Record<string, unknown>, name: string): string {
  try {
    return parseTodoId(args[name]);
  } catch {
    throw new JinnMcpToolError(`${name} must be a canonical Todo ID such as ACM-42`);
  }
}

export function optionalTodoIdField(args: Record<string, unknown>, name: string): string | undefined {
  if (args[name] === undefined || args[name] === null) return undefined;
  return requireTodoIdField(args, name);
}

export function requireRelationKind(args: Record<string, unknown>): (typeof RELATION_KINDS)[number] {
  const kind = typeof args.kind === "string" ? args.kind : "";
  if (!(RELATION_KINDS as readonly string[]).includes(kind)) {
    throw new JinnMcpToolError(`kind must be one of ${RELATION_KINDS.join(", ")}`);
  }
  return kind as (typeof RELATION_KINDS)[number];
}

export function requireLabelRefs(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.labels) || args.labels.length > WORK_ITEM_LABELS_MAX
    || args.labels.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > FILTER_CHAR_CAP)) {
    throw new JinnMcpToolError(`labels must be an array of up to ${WORK_ITEM_LABELS_MAX} label names or ids (non-empty strings) — list_labels shows valid labels`);
  }
  return (args.labels as string[]).map((entry) => entry.trim());
}

/** Which label operation this call is, as the route's own body: `mode` names what
 *  to do with `labels`, and its absence is what replacing the whole set looks like. */
export function requireLabelChange(args: Record<string, unknown>): Record<string, string[]> {
  const refs = requireLabelRefs(args);
  const mode = optionalEnum(args, "mode", ["add", "remove"] as const);
  // An empty `labels` deliberately clears the set; an empty add or remove names
  // nothing, which is a caller that has lost track of what it meant to send.
  if (mode !== undefined && refs.length === 0) {
    throw new JinnMcpToolError(`labels must name at least one label to ${mode} — an empty list would change nothing`);
  }
  return { [mode ?? "labels"]: refs };
}

export function optionalString(args: Record<string, unknown>, name: string, max = FILTER_CHAR_CAP): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new JinnMcpToolError(`${name} must be a non-empty string when provided`);
  const s = v.trim();
  assertLength(name, s, max);
  return s;
}

export function optionalEnum<T extends readonly string[]>(args: Record<string, unknown>, name: string, values: T): T[number] | undefined {
  const s = optionalString(args, name);
  if (s === undefined) return undefined;
  if (!(values as readonly string[]).includes(s)) {
    throw new JinnMcpToolError(`${name} must be one of ${values.join(", ")}, got "${s}"`);
  }
  return s as T[number];
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Shape only — whether the names exist is decided against the live skills
 *  directory server-side, which is the only place that can know. */
export function requireSkillNames(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.skills) || args.skills.length > TODO_SKILLS_MAX
    || args.skills.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > FILTER_CHAR_CAP)) {
    throw new JinnMcpToolError(`skills must be an array of up to ${TODO_SKILLS_MAX} installed skill names (non-empty strings) — each names a skills/<name>/SKILL.md, not an MCP tool`);
  }
  return (args.skills as string[]).map((entry) => entry.trim());
}

/** Refuse a removed Todo field loudly: dropping it would report success while
 *  losing what the caller meant to say. */
export function rejectRetiredFields(args: Record<string, unknown>): void {
  const refusal = retiredTodoFieldError(args, { ignoreNull: true });
  if (refusal) throw new JinnMcpToolError(refusal);
}
