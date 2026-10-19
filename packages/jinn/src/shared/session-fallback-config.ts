import type { SessionFallbackChainView } from "./fallback-chain-wire.js";

/**
 * `sessions.fallbackMode`: what a session does when its model hits a usage
 * limit. Kept beside `context-config.ts` so the schema can grow without
 * pushing `config-types.ts` past its size budget; the type, the shared wire
 * shapes and the validation live together.
 *
 * - `fallback`: may switch to the configured fallback; its children park
 *   and resume instead (they get `auto-resume`).
 * - `fallback-children`: as `fallback`, and its children inherit it.
 * - `auto-resume`: never switches; parks and resumes when the limit returns.
 */
export const SESSION_FALLBACK_MODES = ["fallback", "fallback-children", "auto-resume"] as const;

export type SessionFallbackMode = (typeof SESSION_FALLBACK_MODES)[number];

/** The mode a session follows when neither it nor the config names one. */
export const DEFAULT_SESSION_FALLBACK_MODE: SessionFallbackMode = "fallback";

/** What a session would fall back to, resolved from config alone. */
export interface SessionFallbackTarget {
  engine: string;
  account?: string;
  model?: string;
  label: string;
}

/** The engine and model an operator chose as one session's usage-limit fallback (`sessions.fallback_target`). */
export interface StoredFallbackTarget {
  engine: string;
  model: string;
}

/** A session's fallback setting as the API reports it. `targetSource` says whether `target` is the
 *  session's own choice or what the config's chains would give. */
export interface SessionFallbackView {
  mode: SessionFallbackMode;
  modeSource: "session" | "default";
  target: SessionFallbackTarget | null;
  targetSource: "session" | "config";
  /** The installed engines this session may choose as its own fallback target (a scoped session: claude; a remote one: the engines that run on a host). */
  allowedEngines: string[];
  /** The session's resolved chain, where it is on it and what happened (docs/fallback-chains.md). */
  chain: SessionFallbackChainView;
}

export function isSessionFallbackMode(value: unknown): value is SessionFallbackMode {
  return typeof value === "string" && (SESSION_FALLBACK_MODES as readonly string[]).includes(value);
}

/** A stored column value: a known mode, else NULL (follow the config). */
export function storedFallbackMode(value: unknown): SessionFallbackMode | null {
  return isSessionFallbackMode(value) ? value : null;
}

/** The message a refused `fallbackMode` carries, naming what is allowed. */
export function sessionFallbackModeError(value: unknown): string {
  return `fallbackMode must be one of ${SESSION_FALLBACK_MODES.join(", ")} (got ${typeof value === "string" ? `"${value}"` : value === null ? "null" : typeof value})`;
}

/** Problems with `sessions.fallbackMode`, for the config loader. */
export function sessionFallbackConfigProblems(sessions: unknown): string[] {
  if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) return [];
  const { fallbackMode } = sessions as Record<string, unknown>;
  if (fallbackMode === undefined || isSessionFallbackMode(fallbackMode)) return [];
  return [`sessions.${sessionFallbackModeError(fallbackMode)}`];
}

/** A stored or requested target: an object with a non-empty engine and model, else null. */
export function parseStoredFallbackTarget(value: unknown): StoredFallbackTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { engine, model } = value as Record<string, unknown>;
  if (typeof engine !== "string" || typeof model !== "string") return null;
  return engine.trim() && model.trim() ? { engine: engine.trim(), model: model.trim() } : null;
}

/** A stored column value (JSON text) as a target, else NULL (follow the chain). */
export function storedFallbackTarget(value: unknown): StoredFallbackTarget | null {
  if (typeof value !== "string") return null;
  try {
    return parseStoredFallbackTarget(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The message a malformed `fallbackTarget` carries. */
export function sessionFallbackTargetShapeError(value: unknown): string {
  return `fallbackTarget must be null or an object with a non-empty "engine" and "model" (got ${Array.isArray(value) ? "array" : typeof value})`;
}
