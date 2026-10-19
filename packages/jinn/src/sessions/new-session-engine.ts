import type { Employee, Engine, JinnConfig, JsonObject } from "../shared/types.js";
import { engineAvailable, getModelRegistry, type EngineName } from "../shared/models.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { resolveEmployeeClaudeProfile } from "../shared/claude-profile.js";
import { substituteHealth } from "./rate-limit-account.js";
import { engineHealthForTarget, readEngineHealth } from "../shared/engine-health.js";
import { availabilityRegistry } from "./availability-registry.js";
import { rerouteAtCreation, type RerouteChoice } from "./fallback-reroute.js";
import { logger } from "../shared/logger.js";
import { reroutedSessionMeta } from "./engine-override-window.js";
import { runsOnlyOnClaude } from "./scoped-engine.js";
import { startsOnPreferredEngine } from "./session-fallback.js";
import type { SessionFallbackMode } from "../shared/session-fallback-config.js";

/** What a routed turn brought with it about where the session should run. */
export interface NewSessionEnginePreference {
  engine?: string;
  model?: string;
  effortLevel?: string;
  employee?: Employee;
  /** The mode the new session will carry; absent, the config's. `auto-resume` starts it on its preferred engine. */
  fallbackMode?: SessionFallbackMode;
}

/**
 * The model and effort level the session starts with. A reroute moved off the
 * engine the employee's pair was configured for, so on that path only what the
 * caller named survives and the substitute runs on its own configured defaults,
 * the way a mid-turn fallback already does.
 */
function inheritedDefaults(
  preference: NewSessionEnginePreference,
  rerouted: boolean,
): { model?: string; effortLevel?: string } {
  const employee = rerouted ? undefined : preference.employee;
  return {
    model: preference.model ?? employee?.model ?? undefined,
    effortLevel: preference.effortLevel ?? employee?.effortLevel ?? undefined,
  };
}

/**
 * Where a session that preferred `preferred` should start instead, when that
 * target is out of allowance: the first usable link of its chain that is not out
 * itself (`rerouteAtCreation`). An engine the caller named wins, and so does a
 * named model — a model belongs to exactly one engine — so neither is reordered.
 */
function healthyStart(
  config: JinnConfig,
  engines: Map<string, Engine>,
  preference: NewSessionEnginePreference,
  preferred: EngineName,
): RerouteChoice | undefined {
  const named = preference.engine !== undefined || preference.model !== undefined;
  // A local named Claude profile is its own account (FR-056): its session starts where it
  // prefers, whatever the default account's health says; a rate limit then walks its own chain.
  const ownAccount = preferred === "claude" && resolveEmployeeClaudeProfile(preference.employee) !== null;
  // A department-scoped employee runs only on claude; a rate limit then moves it between claude accounts only.
  if (named || ownAccount || runsOnlyOnClaude(preference.employee?.name) || startsOnPreferredEngine(config, preference.fallbackMode)) return undefined;
  // A remote employee's preference may only be reordered within the engines that
  // can actually run on its host. Rerouting it onto one that ignores
  // `remoteHost` would start the session on an engine whose every turn the
  // remote gate then refuses — a session that looks started and can never run.
  const remote = isRemoteTarget(preference.employee);
  // Scoped to the machine this session will actually run on: a login that
  // died on the gateway is no reason to move a remote employee's session.
  const health = substituteHealth(engineHealthForTarget(readEngineHealth(), preference.employee), preference.employee);
  const registry = availabilityRegistry(getModelRegistry(config), (candidate) => engines.has(candidate) && engineAvailable(config, candidate as EngineName));
  return rerouteAtCreation({
    config, employee: preference.employee, engine: preferred, model: preference.employee?.model, registry, health, scope: { scoped: false, remote },
  });
}

/**
 * The engine, model and effort level a NEW routed session starts on.
 *
 * Anything the caller did not name is a preference, so a target whose allowance
 * is spent gives way to the first member of its chain that can serve the turn —
 * and the session remembers what it preferred, so it goes back once that
 * allowance returns instead of staying on the stand-in.
 */
export function newSessionEngineSelection(
  config: JinnConfig,
  engines: Map<string, Engine>,
  preference: NewSessionEnginePreference,
  transportMeta?: JsonObject | null,
): { engine: EngineName; model?: string; effortLevel?: string; transportMeta?: JsonObject } {
  const preferred = (preference.engine ?? preference.employee?.engine ?? config.engines.default) as EngineName;
  const choice = healthyStart(config, engines, preference, preferred);
  if (!choice) {
    return { engine: preferred, ...inheritedDefaults(preference, false), ...(transportMeta ? { transportMeta } : {}) };
  }
  logger.info(`Engine "${preferred}" is out of allowance — starting this session on "${choice.engine}" instead, until ${choice.reroute.until.toISOString()}`);
  return {
    engine: choice.engine,
    ...inheritedDefaults(preference, true),
    // The chain's own model for the link, when it names one; the employee's model belongs to the target left.
    ...(choice.model ? { model: choice.model } : {}),
    transportMeta: reroutedSessionMeta(choice.reroute, transportMeta),
  };
}
