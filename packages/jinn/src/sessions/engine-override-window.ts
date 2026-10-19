/**
 * How long a session stays on a stand-in: the `engineOverride` window a session
 * started on one is born with, and the revert's extension of a window whose
 * engine is still known to be spent. The record's shape and the revert itself
 * live in `engine-override.ts`.
 */

import { logger } from "../shared/logger.js";
import { engineHealthForTarget, exhaustedEngineReturnsAt, isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { orgRegistry } from "../gateway/org-registry.js";
import type { Employee, JsonObject, Session } from "../shared/types.js";
import { substituteHealth } from "./rate-limit-account.js";
import { updateSession } from "./registry.js";
import type { FallbackRunState } from "./fallback-run.js";

/** A new session started on a stand-in because its preferred engine was out of
 *  allowance when it was created: the engine and model it would otherwise have
 *  run, and when that engine may serve turns again. */
export interface SessionReroute {
  from: string;
  model: string | null;
  until: Date;
  /** The chain link it was moved to, as the override records it. */
  target?: { engine: string; profile?: string; model?: string };
  /** The run a chain reroute starts, at that link. */
  run?: FallbackRunState;
  /** Set when the link is another Claude account rather than another engine. */
  account?: { original: string; substitute: string; configDir: string | null };
}

/**
 * The transport meta a session rerouted at creation starts with: the same record
 * a mid-turn swap parks, so the revert hands the session back to the engine it
 * preferred once `until` passes. Without it, nothing remembers the preference and
 * the session runs on the stand-in for good.
 *
 * Nothing ran on the preferred engine yet, so there is no thread to park, and the
 * sync point is the session's birth: the first turn back carries everything.
 */
export function reroutedSessionMeta(
  reroute: SessionReroute | undefined,
  meta?: JsonObject | null,
  now: Date = new Date(),
): JsonObject | undefined {
  if (!reroute) return meta ?? undefined;
  return {
    ...(meta ?? {}),
    engineOverride: {
      originalEngine: reroute.from,
      originalEngineSessionId: null,
      originalModel: reroute.model,
      until: reroute.until.toISOString(),
      syncSince: now.toISOString(),
      ...(reroute.account
        ? { originalAccount: reroute.account.original, substituteAccount: reroute.account.substitute, substituteConfigDir: reroute.account.configDir }
        : {}),
      ...(reroute.target ? { substituteTarget: reroute.target } : {}),
    },
    ...(reroute.run ? { fallbackRun: { ...reroute.run } } : {}),
  } as JsonObject;
}

/** The employee a session runs as, for reading health the way its turns would. */
function sessionEmployee(session: Session, employee: Employee | undefined): Employee | undefined {
  if (employee || !session.employee) return employee;
  try {
    return orgRegistry().get(session.employee);
  } catch {
    return undefined;
  }
}

/**
 * When a window that has passed should be extended instead of ended: the engine
 * it was waiting for is still recorded as spent, typically because another
 * session's probe found it still limited and pushed its re-probe out. Every
 * session parked on it would otherwise spend a turn rediscovering that. Only an
 * engine swap reads this: an account swap's window is its own account's, and the
 * record under `claude` speaks for the default account.
 */
function stillSpentUntil(session: Session, override: Record<string, unknown>, engine: string, employee: Employee | undefined): Date | undefined {
  if (override.originalAccount !== undefined || override.substituteAccount !== undefined) return undefined;
  const owner = sessionEmployee(session, employee);
  // Read as the session's own turns would: on its host, and on its own Claude account when it has one.
  const health = substituteHealth(engineHealthForTarget(readEngineHealth(), owner), owner);
  return isEngineExhausted(health, engine) ? exhaustedEngineReturnsAt(health, engine) : undefined;
}

/** The session with its window moved out to the engine's recorded return, when
 *  that engine is still spent; `undefined` when the window should end now. */
export function extendSpentWindow(
  session: Session,
  meta: Record<string, unknown>,
  override: Record<string, unknown>,
  engine: string,
  employee: Employee | undefined,
): Session | undefined {
  const extendTo = stillSpentUntil(session, override, engine, employee);
  if (!extendTo) return undefined;
  logger.info(`Session ${session.id}: ${engine} is still out of allowance — staying on ${session.engine} until ${extendTo.toISOString()}`);
  return updateSession(session.id, {
    transportMeta: { ...meta, engineOverride: { ...override, until: extendTo.toISOString() } } as never,
  }) ?? session;
}
