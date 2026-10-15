import { orgRegistry } from "./org-registry.js";
import { getModelRegistry } from "../shared/models.js";
import {
  isSessionFallbackMode, sessionFallbackModeError, type SessionFallbackMode, type SessionFallbackView,
} from "../shared/session-fallback-config.js";
import type { Session } from "../shared/types.js";
import { sessionFallbackView } from "../sessions/session-fallback.js";
import type { ApiContext } from "./api.js";

/**
 * The HTTP face of a session's fallback mode: reading the optional
 * `fallbackMode` a request carries, and the `fallback` view a single-session
 * response adds. The resolution itself is `sessions/session-fallback.ts`.
 */

/** A request's `fallbackMode`: absent is fine, anything but one of the modes is refused naming them. */
export function parseFallbackModeParam(value: unknown): { ok: true; mode?: SessionFallbackMode } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  return isSessionFallbackMode(value) ? { ok: true, mode: value } : { ok: false, error: sessionFallbackModeError(value) };
}

/** The view for one session, from the live config and the roster. */
export function fallbackViewFor(session: Session, context: ApiContext): SessionFallbackView {
  const config = context.getConfig();
  const employee = session.employee ? orgRegistry(config).get(session.employee) : undefined;
  return sessionFallbackView(config, getModelRegistry(config), session, employee);
}

/** A single-session response body with its fallback view. */
export function withFallbackView<T extends object>(body: T, session: Session, context: ApiContext): T & { fallback: SessionFallbackView } {
  return { ...body, fallback: fallbackViewFor(session, context) };
}
