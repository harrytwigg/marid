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
import { logger } from "../shared/logger.js";
import { resolveSubstituteModel } from "../shared/engine-fallback.js";
import { isSpellableModelId } from "../shared/model-id.js";
import { accountOverride } from "./session-account.js";
import { isAutoResume } from "./session-fallback.js";
import { extendSpentWindow } from "./engine-override-window.js";
import { effortLevelsForModel, getModelRegistry } from "../shared/models.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import {
  getEngineSessionRef, getSession, nextEngineSessionFields, updateSession, updateSessionForAttempt,
} from "./registry.js";

/** Per-engine config as this module reads it; unconfigured engines resolve to {}. */
type AccountSwap = { original: string; substitute: string; substituteConfigDir: string | null; fallbackModelMap?: Record<string, string> };

/** What the swap parks on the session, to be handed back when `until` passes.
 *  A swap made while an override stands (the substitute, engine or account, was
 *  limited too) keeps the first swap's originals and replaces only the substitute:
 *  the engine, account, thread, model and sync point the session goes back to are
 *  still the ones it had before any swap, and `until` is still when that engine
 *  or account reopens. */
function overrideRecord(session: Session, accounts: AccountSwap | undefined, until: Date, syncSince: string): Record<string, unknown> {
  const previous = standingOverride(session);
  if (previous) {
    return {
      ...previous,
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
  };
}

/** When a swap made now would end: a standing swap's window, which a nested one
 *  keeps, else `undefined` (the new swap's own `until` applies). */
export function standingOverrideUntil(session: Session): Date | undefined {
  const record = standingOverride(session);
  return record ? parkedOverride(record)?.until : undefined;
}

/** The session's override record when one stands that the revert can act on. A
 *  record naming no engine or window to go back to is replaced, not extended. */
function standingOverride(session: Session): Record<string, unknown> | undefined {
  const record = (session.transportMeta as Record<string, unknown> | null | undefined)?.engineOverride;
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  return parkedOverride(record as Record<string, unknown>) ? record as Record<string, unknown> : undefined;
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
  /** The model the substitute runs, when the operator chose one; else it is derived from the session's pin. */
  model?: string;
  /** Set when the substitute is another Claude account rather than an engine
   *  (FR-079): the session keeps its engine and runs on that account's profile. */
  accounts?: AccountSwap;
  until: Date;
  syncSince: string;
  lastError: string;
}): EngineSubstitution | undefined {
  const { session, attemptToken, config, employee, substitute, accounts, until, syncSince, lastError } = opts;

  const engineConfig: EngineConfig = config.engines[substitute as keyof JinnConfig["engines"]] as EngineConfig ?? {};
  const model = opts.model ?? derivedSubstituteModel(config, session, substitute, accounts);
  const engineOverride = overrideRecord(session, accounts, until, syncSince);

  const started = updateSessionForAttempt(session.id, attemptToken, {
    // The limited engine's thread id moves to its own typed ref (a first swap's record
    // keeps a second copy; a nested one keeps the session's own). The mirror belongs to whichever engine is actually running,
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
    // Read off the flipped row: an account substitute's thread lives in its own
    // account's slot, which only the override record makes current.
    resumeSessionId: getEngineSessionRef(accounts ? started : session, substitute).id,
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
function revertedMeta(meta: Record<string, unknown>, session: Session, parked: ParkedOverride, thread: string | null): Record<string, unknown> {
  const next = { ...meta };
  // Whatever the session ran on in between (another engine, another account, or
  // claude itself handed the turn back by an exhausted chain), claude's own thread
  // was left at the first swap, so it is caught up from there.
  if (parked.engine === "claude" && parked.syncSince) {
    next["claudeSyncSince"] = earliestPending(meta["claudeSyncSince"], parked.syncSince);
    // The prompt's sync intro names what happened: another account, not another engine.
    if (accountOverride(session)) next["claudeSyncAccount"] = true;
    else delete next["claudeSyncAccount"];
  } else if (parked.syncSince && !thread) {
    // Any other engine coming back with no thread of its own — a session that
    // was started on the stand-in never ran on it — would open a blank
    // conversation, so it gets the same transcript an engine switch does.
    const pending = meta["engineSyncTarget"] === parked.engine ? meta["engineSyncSince"] : undefined;
    next["engineSyncTarget"] = parked.engine;
    next["engineSyncSince"] = earliestPending(pending, parked.syncSince);
  }
  delete next["engineOverride"];
  return next;
}

/**
 * The sync point an engine coming back is owed: the earlier of the one this swap
 * parked and one an earlier return left unconsumed. A marker still on the row was
 * never settled by a clean synced turn — the engine went back, was still limited,
 * and the session swapped away again — so everything since it is still missing
 * from the engine's conversation, not only what happened since the latest swap.
 */
function earliestPending(pending: unknown, parked: string): string {
  const pendingMs = typeof pending === "string" ? Date.parse(pending) : NaN;
  return Number.isFinite(pendingMs) && pendingMs < Date.parse(parked) ? pending as string : parked;
}

/** The thread the restored engine resumes. A chain that handed the turn back to
 *  the original engine on its own account ran that engine's own thread, so the
 *  live id is the newest one (and the one the revert parks in its slot). */
function restoredThread(session: Session, meta: Record<string, unknown>, parked: ParkedOverride): string | null {
  if (session.engine === parked.engine && !accountOverride(session) && session.engineSessionId) return session.engineSessionId;
  // The original account's own slot, read without the record that points the
  // session's Claude slot at the substitute account.
  const unswapped: Session = { ...session, transportMeta: { ...meta, engineOverride: undefined } as never };
  return parked.engineSessionId ?? getEngineSessionRef(unswapped, parked.engine).id ?? null;
}

/** The session while its stand-in still holds: the window is open, or the engine is known to be
 *  spent still and the window moved out. Undefined when it is over, and always for `auto-resume`. */
function heldOverride(opts: {
  session: Session; meta: Record<string, unknown>; override: Record<string, unknown>; parked: ParkedOverride;
  employee?: Employee; config?: Pick<JinnConfig, "sessions">;
}): Session | undefined {
  const { session, meta, override, parked, employee, config } = opts;
  if (isAutoResume(config ?? {}, session)) return undefined;
  if (parked.until.getTime() > Date.now()) return session;
  return extendSpentWindow(session, meta, override, parked.engine, employee);
}

/** Restore the pre-rate-limit engine, and the model that belonged to it, once the
 *  override window has expired — or move the window out, when the engine is
 *  known to be spent still. A session whose fallback mode is `auto-resume` never
 *  stands on a stand-in: its override counts as expired at once (`config` says
 *  whether the default makes it so; without it only the session's own mode counts). */
export function maybeRevertEngineOverride(session: Session, employee?: Employee, config?: Pick<JinnConfig, "sessions">): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const parked = parkedOverride(override);
  if (!parked) return session;
  const held = heldOverride({ session, meta, override, parked, employee, config });
  if (held) return held;

  // Park the fallback engine's own thread id under its typed ref before handing
  // the mirror back to the engine being restored.
  const preserved = session.engineSessionId
    ? nextEngineSessionFields(session, session.engine, session.engineSessionId)
    : {};

  const thread = restoredThread(session, meta, parked);
  logger.info(
    `Session ${session.id}: ${parked.engine}'s stand-in window ended at ${parked.until.toISOString()} — `
    + `moving back from ${session.engine} to ${parked.engine}${parked.model ? ` (model: ${parked.model})` : ""}`,
  );
  return updateSession(session.id, {
    ...preserved,
    engine: parked.engine,
    engineSessionId: thread,
    ...(parked.model !== undefined ? { model: parked.model } : {}),
    transportMeta: revertedMeta(meta, session, parked, thread) as never,
    lastError: null,
  }) ?? session;
}
