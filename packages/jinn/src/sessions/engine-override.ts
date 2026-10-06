/**
 * The `transportMeta.engineOverride` record: written when a rate limit moves a
 * session onto a stand-in engine, read back when the window it named expires.
 *
 * Both halves live here because they are the only two things that have to agree
 * about the record's shape, and about what a swap takes away. Engine and model
 * are taken together — a model id belongs to exactly one provider, so a codex pin
 * left on a session claude is now running is a turn that cannot be served
 * (`model_not_found`) — so they are given back together too.
 */

import { resolveEffort } from "../shared/effort.js";
import { resolveSubstituteModel } from "../shared/engine-fallback.js";
import { effortLevelsForModel, getModelRegistry } from "../shared/models.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import {
  getEngineSessionRef, getSession, nextEngineSessionFields, updateSession, updateSessionForAttempt,
} from "./registry.js";

/** Per-engine config as this module reads it; unconfigured engines resolve to {}. */
type EngineConfig = { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };

/** What the stand-in runs as, once the session row has been flipped onto it. */
export interface EngineSubstitution {
  engineConfig: EngineConfig;
  /** The model to run, already known to be one the stand-in serves. */
  model: string | undefined;
  effortLevel: string;
  /** The stand-in's own thread id, when it has one to resume. */
  resumeSessionId: string | undefined;
}

/**
 * Flip a session onto the engine standing in for its limited one, and return what
 * that engine should run as — or `undefined` when the attempt fence was lost and
 * the caller should treat the turn as cancelled.
 */
export function beginEngineSubstitution(opts: {
  session: Session;
  attemptToken: string;
  config: JinnConfig;
  employee: Employee | undefined;
  substitute: string;
  until: Date;
  syncSince: string;
  lastError: string;
}): EngineSubstitution | undefined {
  const { session, attemptToken, config, employee, substitute, until, syncSince, lastError } = opts;

  const engineConfig: EngineConfig = config.engines[substitute as keyof JinnConfig["engines"]] as EngineConfig ?? {};
  const model = resolveSubstituteModel(config, getModelRegistry(config), {
    from: session.engine, to: substitute, model: session.model,
  });

  const engineOverride = {
    originalEngine: session.engine,
    originalEngineSessionId: session.engineSessionId,
    // The pin comes off the row for the duration, so the record is the only place
    // it survives to be handed back from.
    originalModel: session.model ?? null,
    until: until.toISOString(),
    syncSince,
  };

  const started = updateSessionForAttempt(session.id, attemptToken, {
    // The limited engine's thread id moves to its own typed ref (the override record
    // keeps a second copy). The mirror belongs to whichever engine is actually running,
    // so it goes null until the substitute returns a thread id of its own.
    ...(session.engineSessionId ? nextEngineSessionFields(session, session.engine, session.engineSessionId) : {}),
    engine: substitute,
    engineSessionId: null,
    model: model ?? null,
    // The live row, not the snapshot: this turn may already have written to it.
    transportMeta: { ...((getSession(session.id) ?? session).transportMeta || {}), engineOverride } as never,
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError,
  });
  if (!started) return undefined;

  return {
    engineConfig,
    model,
    effortLevel: resolveEffort(engineConfig, session, employee, effortLevelsForModel(config, substitute, model ?? engineConfig.model)),
    resumeSessionId: getEngineSessionRef(session, substitute).id,
  };
}

/** What the swap parked, or null when the record names no engine to go back to. */
interface ParkedOverride {
  engine: string;
  engineSessionId: string | null;
  /** The pin to restore; `undefined` on a record written before the swap parked one. */
  model: string | null | undefined;
  syncSince: string | null;
  until: Date;
}

function parkedOverride(override: Record<string, unknown>): ParkedOverride | null {
  const engine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!engine || !untilIso) return null;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return null;

  return {
    engine,
    engineSessionId: typeof override.originalEngineSessionId === "string" ? override.originalEngineSessionId : null,
    model: "originalModel" in override
      ? (typeof override.originalModel === "string" ? override.originalModel : null)
      : undefined,
    syncSince: typeof override.syncSince === "string" ? override.syncSince : null,
    until,
  };
}

/** The transport meta a restored session carries: the spent record gone, and the
 *  sync marker in its place when the engine coming back is the one that needs it. */
function revertedMeta(meta: Record<string, unknown>, session: Session, parked: ParkedOverride): Record<string, unknown> {
  const next = { ...meta };
  if (parked.engine === "claude" && parked.syncSince && session.engine !== "claude") {
    next["claudeSyncSince"] = parked.syncSince;
  }
  delete next["engineOverride"];
  return next;
}

/** Restore the pre-rate-limit engine, and the model that belonged to it, once the
 *  override window has expired. */
export function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const parked = parkedOverride(override);
  if (!parked) return session;
  if (parked.until.getTime() > Date.now()) return session;

  // Park the fallback engine's own thread id under its typed ref before handing
  // the mirror back to the engine being restored.
  const preserved = session.engineSessionId
    ? nextEngineSessionFields(session, session.engine, session.engineSessionId)
    : {};

  return updateSession(session.id, {
    ...preserved,
    engine: parked.engine,
    engineSessionId: parked.engineSessionId ?? getEngineSessionRef(session, parked.engine).id ?? null,
    ...(parked.model !== undefined ? { model: parked.model } : {}),
    transportMeta: revertedMeta(meta, session, parked) as never,
    lastError: null,
  }) ?? session;
}
