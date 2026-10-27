/**
 * How long a session stays on a stand-in: the `engineOverride` window a session
 * started on one is born with, and the revert's extension of a window whose
 * engine is still known to be spent. The record's shape and the revert itself
 * live in `engine-override.ts`.
 */

import { logger } from "../shared/logger.js";
import { engineHealthForTarget, exhaustedEngineReturnsAt, isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { accountForEmployee } from "../shared/engine-account.js";
import { healthKeys } from "../shared/fallback-chain-health.js";
import { orgRegistry } from "../gateway/org-registry.js";
import type { Employee, JinnConfig, JsonObject, Session } from "../shared/types.js";
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

/** The target a swap left: the engine and the model it ran (null when it ran its default). */
export interface OwnTarget {
  engine: string;
  model: string | null | undefined;
}

/**
 * When a window that has passed should be extended instead of ended: the target
 * the session is waiting for is still recorded as spent, typically because
 * another session's probe found it still limited and pushed its re-probe out.
 * Every session parked on it would otherwise spend a turn rediscovering that.
 *
 * The target is read the way a chain reads a link's health: a Claude account by
 * its own key (the account an account swap left, else the employee's), an
 * opencode model by its provider, anything else by its engine. One health store,
 * so the answer is the same one the limits readout and the chain walk give.
 */
function stillSpentUntil(
  session: Session, override: Record<string, unknown>, own: OwnTarget, reader: { employee?: Employee; config?: Partial<Pick<JinnConfig, "engines">> },
): Date | undefined {
  const { engine } = own;
  const { employee, config } = reader;
  const owner = sessionEmployee(session, employee);
  // An unpinned session ran its employee's model, else the engine's default: an opencode
  // limit is held against that model's provider, so the key needs it.
  const defaults = config?.engines as Record<string, { model?: string } | undefined> | undefined;
  const model = own.model ?? owner?.model ?? defaults?.[engine]?.model;
  // Read as the session's own turns would: on its host.
  const health = engineHealthForTarget(readEngineHealth(), owner);
  const account = typeof override.originalAccount === "string" ? override.originalAccount : accountForEmployee(owner, engine);
  const spent = healthKeys({ engine, model: model ?? undefined, account }).find((key) => isEngineExhausted(health, key));
  return spent === undefined ? undefined : exhaustedEngineReturnsAt(health, spent);
}

/** The session with its window moved out to the target's recorded return, when
 *  that target is still spent; `undefined` when the window should end now. */
export function extendSpentWindow(
  session: Session,
  meta: Record<string, unknown>,
  override: Record<string, unknown>,
  own: OwnTarget,
  reader: { employee?: Employee; config?: Partial<Pick<JinnConfig, "engines">> },
): Session | undefined {
  const extendTo = stillSpentUntil(session, override, own, reader);
  if (!extendTo) return undefined;
  logger.info(`Session ${session.id}: ${own.engine} is still out of allowance — staying on ${session.engine} until ${extendTo.toISOString()}`);
  return updateSession(session.id, {
    transportMeta: { ...meta, engineOverride: { ...override, until: extendTo.toISOString() } } as never,
  }) ?? session;
}
