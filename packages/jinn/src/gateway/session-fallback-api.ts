import { orgRegistry } from "./org-registry.js";
import { getModelRegistry } from "../shared/models.js";
import {
  isSessionFallbackMode, sessionFallbackModeError, type SessionFallbackMode, type SessionFallbackView,
} from "../shared/session-fallback-config.js";
import type { Session } from "../shared/types.js";
import type { UpdateSessionFields } from "../sessions/registry.js";
import { fallbackTargetRefusal, parseFallbackTargetPatch } from "../sessions/fallback-target.js";
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

/** A PUT/PATCH's `fallbackMode`: as above, and null clears the session's own mode so it follows the config default again. */
export function parseFallbackModePatch(value: unknown): { ok: true; mode?: SessionFallbackMode | null } | { ok: false; error: string } {
  return value === null ? { ok: true, mode: null } : parseFallbackModeParam(value);
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

/**
 * A PUT/PATCH's `fallbackTarget`: absent leaves it, null clears it back to the config's chain, an
 * `{engine, model}` object sets it when this session may have it (the substitute walk's own filters,
 * the engine installed, a model it offers). A refusal names why. Writes into `updates` when it applies.
 */
export function applyFallbackTargetPatch(
  value: unknown,
  session: Session,
  context: ApiContext,
  updates: Pick<UpdateSessionFields, "fallbackTarget">,
): { ok: true } | { ok: false; error: string } {
  const parsed = parseFallbackTargetPatch(value);
  if (!parsed.ok) return parsed;
  if (parsed.target === undefined) return { ok: true };
  if (parsed.target) {
    const config = context.getConfig();
    const employee = session.employee ? orgRegistry(config).get(session.employee) : undefined;
    const refusal = fallbackTargetRefusal(config, session, employee, parsed.target);
    if (refusal) return { ok: false, error: `fallbackTarget refused: ${refusal}` };
  }
  updates.fallbackTarget = parsed.target;
  return { ok: true };
}
