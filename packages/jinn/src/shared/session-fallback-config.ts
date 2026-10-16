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

/** A session's fallback setting as the API reports it. */
export interface SessionFallbackView {
  mode: SessionFallbackMode;
  modeSource: "session" | "default";
  target: SessionFallbackTarget | null;
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
