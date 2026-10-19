/**
 * The `transportMeta.engineOverride` record: written when a rate limit moves a
 * session onto a stand-in engine, read back when the window it named expires
 * (`engine-override-revert.ts` reads it, and gives the session back).
 *
 * The two halves have to agree about the record's shape, and about what a swap
 * takes away. Engine and model are taken together — a model id belongs to
 * exactly one provider, so a codex pin left on a session claude is now running
 * is a turn that cannot be served (`model_not_found`) — so they are given back
 * together too.
 */

import { resolveEffort } from "../shared/effort.js";
import { resolveSubstituteModel } from "../shared/engine-fallback.js";
import { isSpellableModelId } from "../shared/model-id.js";
import { standingOverride } from "./engine-override-revert.js";
import { effortLevelsForModel, getModelRegistry } from "../shared/models.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { getEngineSessionRef, getSession, nextEngineSessionFields, updateSessionForAttempt } from "./registry.js";
import type { FallbackHop } from "../shared/fallback-chain-wire.js";
import { withHop, withRun, type FallbackRunState } from "./fallback-run.js";

export { maybeRevertEngineOverride, standingOverrideUntil } from "./engine-override-revert.js";

/** Per-engine config as this module reads it; unconfigured engines resolve to {}. */
type AccountSwap = { original: string; substitute: string; substituteConfigDir: string | null; fallbackModelMap?: Record<string, string> };

/** The target the stand-in runs, as the override records it: an engine, the declared profile it runs as (Claude only) and its model. */
export interface SubstituteTarget {
  engine: string;
  profile?: string;
  model?: string;
}

/** What the swap parks on the session, to be handed back when `until` passes.
 *  A swap made while an override stands (the substitute, engine or account, was
 *  limited too) keeps the first swap's originals and replaces only the substitute:
 *  the engine, account, thread, model and sync point the session goes back to are
 *  still the ones it had before any swap, and `until` is still when that engine
 *  or account reopens. */
function overrideRecord(
  session: Session, accounts: AccountSwap | undefined, until: Date, syncSince: string, target: SubstituteTarget | undefined,
): Record<string, unknown> {
  const previous = standingOverride(session);
  const substituteTarget = target ? { substituteTarget: target } : {};
  if (previous) {
    return {
      ...previous,
      // A nested swap names its own target; one written without a target leaves none behind from the swap before it.
      substituteTarget: target,
      ...(accounts
        // A first swap onto another engine named no account; the one the session leaves now is its own.
        ? { originalAccount: previous.originalAccount ?? accounts.original, substituteAccount: accounts.substitute, substituteConfigDir: accounts.substituteConfigDir }
        : { substituteAccount: undefined, substituteConfigDir: undefined, originalAccount: undefined }),
    };
  }
  return {
    originalEngine: session.engine,
    originalEngineSessionId: session.engineSessionId,
    // The pin comes off the row for the duration, so the record is the only place
    // it survives to be handed back from.
    originalModel: session.model ?? null,
    until: until.toISOString(),
    syncSince,
    ...(accounts ? { originalAccount: accounts.original, substituteAccount: accounts.substitute, substituteConfigDir: accounts.substituteConfigDir } : {}),
    ...substituteTarget,
  };
}

/** A model id belongs to one provider, and an account swap stays on it: the pin
 *  survives, through the original account's `fallbackModelMap` when it maps it. */
function accountSwapModel(accounts: AccountSwap, model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const mapped = accounts.fallbackModelMap?.[model];
  return typeof mapped === "string" && isSpellableModelId(mapped) ? mapped : model;
}


type EngineConfig = { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };

/** The model a stand-in nobody chose a model for runs: through the account's map for an account swap, else the engine's. */
function derivedSubstituteModel(config: JinnConfig, session: Session, substitute: string, accounts: AccountSwap | undefined): string | undefined {
  return accounts
    ? accountSwapModel(accounts, session.model)
    : resolveSubstituteModel(config, getModelRegistry(config), { from: session.engine, to: substitute, model: session.model });
}

/** What the stand-in runs as, once the session row has been flipped onto it. */
export interface EngineSubstitution {
  engineConfig: EngineConfig;
  /** The model to run, already known to be one the stand-in serves. */
  model: string | undefined;
  effortLevel: string;
  /** The stand-in's own thread id, when it has one to resume. */
  resumeSessionId: string | undefined;
  /** When that thread was last brought up to date (its slot's `lastSyncedAt`): what it has not seen is owed to it. */
  syncedThrough: string | undefined;
}

/** A chain hop made along with the swap: the run as it stands once the session is on the stand-in, and the hops to record (oldest first). */
export interface SwapFallbackRecord {
  run: FallbackRunState;
  hops: FallbackHop[];
}

/** What a swap needs to know. */
export interface BeginSubstitutionOpts {
  session: Session;
  attemptToken: string;
  config: JinnConfig;
  employee: Employee | undefined;
  substitute: string;
  /** The model the substitute runs, when the operator chose one; else it is derived from the session's pin. */
  model?: string;
  /** Set when the substitute is another Claude account rather than an engine
   *  (FR-079): the session keeps its engine and runs on that account's profile. */
  accounts?: AccountSwap;
  until: Date;
  syncSince: string;
  lastError: string;
  /** The chain link the stand-in is, recorded on the override. */
  target?: SubstituteTarget;
  /** The run and hops this swap makes, written with the flip so no reader sees one without the other. */
  fallback?: SwapFallbackRecord;
}

/**
 * Flip a session onto the engine standing in for its limited one, and return what
 * that engine should run as — or `undefined` when the attempt fence was lost and
 * the caller should treat the turn as cancelled.
 */
export function beginEngineSubstitution(opts: BeginSubstitutionOpts): EngineSubstitution | undefined {
  const { session, attemptToken, config, substitute, accounts, lastError } = opts;

  const engineConfig: EngineConfig = config.engines[substitute as keyof JinnConfig["engines"]] as EngineConfig ?? {};
  const model = opts.model ?? derivedSubstituteModel(config, session, substitute, accounts);

  const started = updateSessionForAttempt(session.id, attemptToken, {
    // The limited engine's thread id moves to its own typed ref (a first swap's record
    // keeps a second copy; a nested one keeps the session's own). The mirror belongs to whichever engine is actually running,
    // so it goes null until the substitute returns a thread id of its own.
    ...(session.engineSessionId ? nextEngineSessionFields(session, session.engine, session.engineSessionId) : {}),
    engine: substitute,
    engineSessionId: null,
    model: model ?? null,
    transportMeta: swapMeta(opts, model) as never,
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError,
  });
  return started ? substitutionOf(opts, { engineConfig, model, started }) : undefined;
}

/** What the stand-in runs as, read off the row the swap flipped. */
function substitutionOf(opts: BeginSubstitutionOpts, flipped: { engineConfig: EngineConfig; model: string | undefined; started: Session }): EngineSubstitution {
  const { session, config, employee, substitute, accounts } = opts;
  const { engineConfig, model, started } = flipped;
  // Read off the flipped row: an account substitute's thread lives in its own
  // account's slot, which only the override record makes current.
  const slot = getEngineSessionRef(accounts ? started : session, substitute);
  return {
    engineConfig,
    model,
    effortLevel: resolveEffort(engineConfig, session, employee, effortLevelsForModel(config, substitute, model ?? engineConfig.model)),
    resumeSessionId: slot.id,
    syncedThrough: slot.lastSyncedAt,
  };
}

/** The transport meta a swap writes: the live row's, not the snapshot's (this turn may already have written to it), with the override record and, for a chain hop, its run and hops. */
function swapMeta(opts: BeginSubstitutionOpts, model: string | undefined): Record<string, unknown> {
  const { session, accounts, until, syncSince } = opts;
  const target = opts.target && { ...opts.target, ...(model ? { model } : {}) };
  const live = ((getSession(session.id) ?? session).transportMeta || {}) as Record<string, unknown>;
  return swappedMeta({ ...live, engineOverride: overrideRecord(session, accounts, until, syncSince, target) }, opts.fallback);
}

/** The meta with a chain hop's run and hops in it. */
function swappedMeta(meta: Record<string, unknown>, fallback: SwapFallbackRecord | undefined): Record<string, unknown> {
  return fallback ? fallback.hops.reduce(withHop, withRun(meta, fallback.run)) : meta;
}

/**
 * Undo `beginEngineSubstitution` for a substitute that could not take the turn either: the session
 * goes back to the engine, thread and model the turn began on, with the transport meta from before
 * the swap (so no override record is left, and one that already stood is kept). False when the
 * attempt fence was lost.
 */
export function abandonEngineSubstitution(session: Session, attemptToken: string, metaBefore: Session["transportMeta"]): boolean {
  return Boolean(updateSessionForAttempt(session.id, attemptToken, {
    engine: session.engine,
    engineSessionId: session.engineSessionId,
    model: session.model,
    transportMeta: metaBefore ?? null,
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError: null,
  }));
}
