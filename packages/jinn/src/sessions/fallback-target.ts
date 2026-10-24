import type { EngineName } from "../shared/models.js";
import { engineAvailable, getModelRegistry, hasDynamicModelCatalog, isKnownEngine } from "../shared/models.js";
import { sshDestination } from "../shared/remote-target.js";
import { isEngineExhausted, type EngineHealthReading } from "../shared/engine-health.js";
import { resolveEmployeeClaudeProfile } from "../shared/claude-profile.js";
import {
  sessionFallbackTargetShapeError, parseStoredFallbackTarget, type StoredFallbackTarget,
} from "../shared/session-fallback-config.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { scopedDepartmentOf } from "../work-items/department-scope.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";
import type { RemoteEngineName } from "../shared/models.js";
import { effectiveFallbackMode } from "./session-fallback.js";
import { rateLimitAccount, substituteHealth } from "./rate-limit-account.js";
import { accountOverride } from "./session-account.js";
import { engineAllowedAsSubstitute, sessionSubstituteScope, substituteScoped } from "./substitute-filters.js";
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

/** A session that does not exist yet, as far as fallback reads of it: its engine, model and employee (whose department and host decide the scope). */
export function prospectiveSession(
  config: JinnConfig,
  spec: { engine: string; model?: string | null; employee: string | null | undefined },
): { session: Session; employee: Employee | undefined } {
  const employee = spec.employee ? orgRegistry(config).get(spec.employee) : undefined;
  const session = {
    id: "", engine: spec.engine, model: spec.model ?? null, employee: spec.employee ?? null,
    scopeDepartment: scopedDepartmentOf(spec.employee) ?? null, fallbackTarget: null,
  } as unknown as Session;
  return { session, employee };
}

/**
 * The target a child of `parent` is created with: the parent's, when the parent passes its fallback on
 * (`fallback-children`) and the child is not explicitly told to wait out limits. The operator chose it for the
 * parent, so a child that may not use it (a department-scoped employee off claude, a remote one on an engine that
 * cannot run there) gets none and follows the chain under its mode. `child` names the employee it is created for;
 * without it the filters are not applied.
 */
export function childFallbackTarget(
  config: JinnConfig,
  parent: Pick<Session, "fallbackMode" | "fallbackTarget"> | undefined,
  explicitMode?: string,
  child?: { employee: string | null | undefined },
): StoredFallbackTarget | undefined {
  if (!parent?.fallbackTarget || explicitMode === "auto-resume") return undefined;
  if (effectiveFallbackMode(config, parent).mode !== "fallback-children") return undefined;
  const target = parent.fallbackTarget;
  if (!child) return target;
  const { session, employee } = prospectiveSession(config, { engine: "", employee: child.employee });
  return fallbackTargetRefusal(config, session, employee, target) ? undefined : target;
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
  const scope = sessionSubstituteScope(session, employee, config);
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

/** The account swap that keeps a claude model change on the account the session stands on. */
function standingAccountSwap(session: Session): SubstituteChoice["accounts"] {
  const standing = accountOverride(session);
  return standing
    ? { original: standing.originalAccount, substitute: standing.substituteAccount, substituteConfigDir: standing.substituteConfigDir }
    : undefined;
}

export type TargetDecision = { choice: SubstituteChoice } | { reason: string };

/** Why the chosen engine cannot serve this session at all (not an engine we know, not allowed, not installed), or undefined. */
function engineRefusal(input: ChooseSubstituteInput, target: StoredFallbackTarget): string | undefined {
  const { config, engines, session, remote, remoteTarget } = input;
  if (!isKnownEngine(target.engine)) return "is not an engine this gateway knows";
  const scoped = substituteScoped(session, remoteTarget);
  if (!engineAllowedAsSubstitute({ scoped, remote: Boolean(remote) }, target.engine)) {
    return scoped && target.engine !== "claude" ? "is not allowed for a department-scoped session" : "cannot run on this session's remote host";
  }
  const installed = remote
    ? remoteEngineAvailable(sshDestination(remote), target.engine as RemoteEngineName) !== false
    : engines.has(target.engine) && engineAvailable(config, target.engine);
  if (!installed) return remote ? "is not installed on this session's host" : "is not installed";
  return undefined;
}

/** Why the chosen model cannot be switched to now (no longer offered, the one that just hit its limit, or its engine is spent), or undefined. */
function modelRefusal(input: ChooseSubstituteInput, health: EngineHealthReading, target: StoredFallbackTarget): string | undefined {
  const { config, session, employee } = input;
  const offered = getModelRegistry(config)[target.engine]?.models ?? [];
  if (!offered.some((m) => m.id === target.model) && !hasDynamicModelCatalog(target.engine)) return "names a model that is no longer offered";
  if (session.engine === target.engine) return session.model === target.model ? "is the model that just hit its limit" : undefined;
  return isEngineExhausted(substituteHealth(health, employee), target.engine) ? "has hit its own usage limit" : undefined;
}

/**
 * The substitute a session with its own target takes at a usage limit: exactly that
 * engine and model, or the reason it cannot, never the config's chain instead. A
 * same-engine target is a model change on the account the session stands on; engine
 * health is not read for it, because a limit is recorded per engine and may have
 * been the old model's alone.
 */
export function chooseTargetSubstitute(input: ChooseSubstituteInput, health: EngineHealthReading): TargetDecision {
  const { session, employee, remote } = input;
  const target = session.fallbackTarget!;
  const why = engineRefusal(input, target) ?? modelRefusal(input, health, target);
  if (why) return { reason: `the chosen fallback ${targetName(target)} ${why}` };
  const sameEngine = session.engine === target.engine;
  const accounts = target.engine === "claude" && sameEngine && !remote ? standingAccountSwap(session) : undefined;
  const claudeProfile = target.engine !== "claude" || remote ? null
    : sameEngine ? rateLimitAccount("claude", employee, session).claudeProfile : resolveEmployeeClaudeProfile(employee);
  return { choice: { engine: target.engine as EngineName, model: target.model, claudeProfile, ...(accounts ? { accounts } : {}) } };
}
