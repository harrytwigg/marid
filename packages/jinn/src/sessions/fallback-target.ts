import type { EngineName } from "../shared/models.js";
import { engineAvailable, getModelRegistry, hasDynamicModelCatalog, isKnownEngine } from "../shared/models.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { isEngineExhausted, type EngineHealthReading } from "../shared/engine-health.js";
import { resolveEmployeeClaudeProfile } from "../shared/claude-profile.js";
import {
  sessionFallbackTargetShapeError, parseStoredFallbackTarget, type StoredFallbackTarget,
} from "../shared/session-fallback-config.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";
import type { RemoteEngineName } from "../shared/models.js";
import { effectiveFallbackMode } from "./session-fallback.js";
import { rateLimitAccount, substituteHealth } from "./rate-limit-account.js";
import { rateLimitRemoteTarget } from "./rate-limit-remote-target.js";
import { accountOverride } from "./session-account.js";
import { engineAllowedAsSubstitute, substituteScoped } from "./substitute-filters.js";
import type { ChooseSubstituteInput, SubstituteChoice } from "./rate-limit-substitute.js";

/**
 * A session's own usage-limit fallback (`sessions.fallback_target`): the engine
 * and model the operator picked, used instead of the config's chain. Whether a
 * target is allowed for a session is the substitute walk's own filter, so the
 * PUT that stores it, the display and the turn that uses it cannot disagree.
 */

/** What a request's `fallbackTarget` says: absent leaves it alone, null clears, an object sets. */
export function parseFallbackTargetPatch(value: unknown): { ok: true; target?: StoredFallbackTarget | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (value === null) return { ok: true, target: null };
  const target = parseStoredFallbackTarget(value);
  return target ? { ok: true, target } : { ok: false, error: sessionFallbackTargetShapeError(value) };
}

/** The target a child of `parent` is created with: the parent's, when the parent passes its fallback on
 *  (`fallback-children`) and the child is not explicitly told to wait out limits. */
export function childFallbackTarget(
  config: Pick<JinnConfig, "sessions">,
  parent: Pick<Session, "fallbackMode" | "fallbackTarget"> | undefined,
  explicitMode?: string,
): StoredFallbackTarget | undefined {
  if (!parent?.fallbackTarget || explicitMode === "auto-resume") return undefined;
  return effectiveFallbackMode(config, parent).mode === "fallback-children" ? parent.fallbackTarget : undefined;
}

function targetName(target: StoredFallbackTarget): string {
  return `${target.engine} (${target.model})`;
}

/** Why `target` is not one this session may have as its fallback, or null. Used when the choice is stored. */
export function fallbackTargetRefusal(
  config: JinnConfig,
  session: Session,
  employee: Employee | undefined,
  target: StoredFallbackTarget,
): string | null {
  const registry = getModelRegistry(config);
  const entry = registry[target.engine];
  if (!entry) return `unknown engine "${target.engine}"`;
  const scope = scopeOf(config, session, employee);
  if (!engineAllowedAsSubstitute(scope, target.engine as EngineName)) {
    return scope.scoped && target.engine !== "claude"
      ? `this session is confined to a department, so its fallback must stay on claude (not "${target.engine}")`
      : `this session runs on a remote host, and "${target.engine}" cannot run there`;
  }
  if (!engineAvailable(config, target.engine as EngineName)) return `engine "${target.engine}" is not installed`;
  if (!entry.models.some((m) => m.id === target.model) && !hasDynamicModelCatalog(target.engine)) {
    return `unknown model "${target.model}" for engine "${target.engine}"`;
  }
  return null;
}

function scopeOf(config: JinnConfig, session: Session, employee: Employee | undefined): { scoped: boolean; remote: boolean } {
  const remoteTarget = rateLimitRemoteTarget({ session, employee, config });
  return { scoped: substituteScoped(session, remoteTarget), remote: isRemoteTarget(remoteTarget) };
}

/** The account swap that keeps a claude model change on the account the session stands on. */
function standingAccountSwap(session: Session): SubstituteChoice["accounts"] {
  const standing = accountOverride(session);
  return standing
    ? { original: standing.originalAccount, substitute: standing.substituteAccount, substituteConfigDir: standing.substituteConfigDir }
    : undefined;
}

export type TargetDecision = { choice: SubstituteChoice } | { reason: string };

/**
 * The substitute a session with its own target takes at a usage limit: exactly that
 * engine and model, or the reason it cannot, never the config's chain instead. A
 * same-engine target is a model change on the account the session stands on; engine
 * health is not read for it, because a limit is recorded per engine and may have
 * been the old model's alone.
 */
export function chooseTargetSubstitute(input: ChooseSubstituteInput, health: EngineHealthReading): TargetDecision {
  const { config, engines, session, employee, remote, remoteTarget } = input;
  const target = session.fallbackTarget!;
  const name = targetName(target);
  const refuse = (why: string): TargetDecision => ({ reason: `the chosen fallback ${name} ${why}` });
  if (!isKnownEngine(target.engine)) return refuse("is not an engine this gateway knows");
  const scoped = substituteScoped(session, remoteTarget);
  if (!engineAllowedAsSubstitute({ scoped, remote: Boolean(remote) }, target.engine)) {
    return refuse(scoped && target.engine !== "claude" ? "is not allowed for a department-scoped session" : "cannot run on this session's remote host");
  }
  const installed = remote
    ? remoteEngineAvailable(sshDestination(remote), target.engine as RemoteEngineName) !== false
    : engines.has(target.engine) && engineAvailable(config, target.engine);
  if (!installed) return refuse(remote ? "is not installed on this session's host" : "is not installed");
  const offered = getModelRegistry(config)[target.engine]?.models ?? [];
  if (!offered.some((m) => m.id === target.model) && !hasDynamicModelCatalog(target.engine)) return refuse("names a model that is no longer offered");
  const sameEngine = session.engine === target.engine;
  if (sameEngine && session.model === target.model) return refuse("is the model that just hit its limit");
  if (!sameEngine && isEngineExhausted(substituteHealth(health, employee), target.engine)) return refuse("has hit its own usage limit");
  const accounts = target.engine === "claude" && sameEngine && !remote ? standingAccountSwap(session) : undefined;
  const claudeProfile = target.engine !== "claude" || remote ? null
    : sameEngine ? rateLimitAccount("claude", employee, session).claudeProfile : resolveEmployeeClaudeProfile(employee);
  return { choice: { engine: target.engine, model: target.model, claudeProfile, ...(accounts ? { accounts } : {}) } };
}

