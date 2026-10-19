import { declaredClaudeAccounts, type DeclaredClaudeAccount } from "./claude-accounts-config.js";
import { accountForEmployee } from "./engine-account.js";
import { employeeOwnLink } from "./employee-fallback.js";
import type { FallbackExpansionMode } from "./fallback-chain-expand.js";
import {
  inheritedChain, ownTargetLink, resolveFallbackLinks,
  type FallbackChainEnv, type FallbackChainSpec,
} from "./fallback-chain.js";
import {
  fallbackLinkOf,
  type FallbackChainEntry, type FallbackChainSubject, type FallbackChainsResponse, type FallbackProfileOption,
} from "./fallback-chain-wire.js";
import { ENGINE_NAMES } from "./models.js";
import type { Employee, JinnConfig, ModelRegistry } from "./types.js";

/**
 * The chains the editor shows (`GET /api/fallback-chains`): one subject per
 * engine, one per declared Claude account and, on request, one for an employee.
 * Each carries the chain as written, normalised to links, and the chain that
 * would run after legacy expansion, resolved the way a session's is.
 */

/** The target an engine or account falls back from: its default model, as configured or as the registry names it. */
function defaultModel(config: JinnConfig, registry: ModelRegistry, engine: string): string | undefined {
  const section = (config.engines as unknown as Record<string, { model?: string } | undefined>)[engine];
  return section?.model ?? registry[engine]?.defaultModel ?? undefined;
}

/** The declared accounts a chain may name, as the editor's profile picker lists them. */
export function fallbackProfiles(config: JinnConfig): FallbackProfileOption[] {
  return declaredClaudeAccounts(config).map((account) => ({ name: account.name, account: account.key, configDir: account.profile.dir }));
}

function subjectOf(
  env: FallbackChainEnv, identity: Pick<FallbackChainSubject, "kind" | "id">, spec: FallbackChainSpec, written: readonly FallbackChainEntry[] | undefined,
): FallbackChainSubject {
  const [primary, ...effective] = resolveFallbackLinks(env, spec);
  return {
    ...identity,
    primary: primary ?? null,
    configured: written === undefined ? null : written.flatMap((entry) => fallbackLinkOf(entry) ?? []),
    legacy: written?.some((entry) => typeof entry === "string") ?? false,
    effective,
  };
}

const OPEN_SCOPE = { scoped: false, remote: false };

/** An engine's default chain, `engines.<engine>.fallback`. */
export function engineSubject(env: FallbackChainEnv, engine: string): FallbackChainSubject {
  const written = (env.config.engines as unknown as Record<string, { fallback?: FallbackChainEntry[] } | undefined>)[engine]?.fallback;
  const mode: FallbackExpansionMode = engine === "claude" ? "account" : "engine";
  const own = ownTargetLink(env.config, { engine, model: defaultModel(env.config, env.registry, engine) });
  return subjectOf(env, { kind: "engine", id: engine }, { own, ownAccount: engine, entries: written ?? [], mode, scope: OPEN_SCOPE }, written);
}

/** A declared Claude account's chain, `engines.claude.accounts.<name>.fallback`. */
export function accountSubject(env: FallbackChainEnv, account: DeclaredClaudeAccount): FallbackChainSubject {
  const model = defaultModel(env.config, env.registry, "claude");
  const own = { engine: "claude", profile: account.name, ...(model ? { model } : {}) };
  const spec: FallbackChainSpec = { own, ownAccount: account.key, entries: account.fallback ?? [], mode: "account", scope: OPEN_SCOPE };
  return subjectOf(env, { kind: "account", id: account.name }, spec, account.fallback);
}

/**
 * An employee's chain: its own `fallback` when it writes one, else what its
 * account and engine give it. `scope` is what the employee's department and host
 * make of its links (department-scoped, remote), which the caller knows.
 */
export function employeeSubject(env: FallbackChainEnv, employee: Employee, scope: FallbackChainSpec["scope"]): FallbackChainSubject {
  const ownAccount = accountForEmployee(employee, employee.engine);
  const mode: FallbackExpansionMode = employee.engine === "claude" && !scope.remote ? "account" : "engine";
  const entries = employee.fallback ?? inheritedChain(env.config, employee.engine, mode, ownAccount).entries;
  const own = employeeOwnLink(env.config, employee);
  const subject = subjectOf(env, { kind: "employee", id: employee.name }, { own, ownAccount, entries, mode, scope }, employee.fallback);
  return employee.fallbackProblems?.length ? { ...subject, problems: employee.fallbackProblems } : subject;
}

/** The whole response: profiles, every engine and every declared account, and the employee when one is asked for. */
export function fallbackChainsResponse(
  env: FallbackChainEnv, employee?: { employee: Employee; scope: FallbackChainSpec["scope"] },
): FallbackChainsResponse {
  const engines = ENGINE_NAMES.filter((name) => env.registry[name] !== undefined || name === "claude");
  return {
    profiles: fallbackProfiles(env.config),
    subjects: [
      ...engines.map((name) => engineSubject(env, name)),
      ...declaredClaudeAccounts(env.config).map((account) => accountSubject(env, account)),
      ...(employee ? [employeeSubject(env, employee.employee, employee.scope)] : []),
    ],
  };
}
