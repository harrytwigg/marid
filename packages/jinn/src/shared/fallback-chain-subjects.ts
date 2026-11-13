import { declaredAccountByKey, declaredClaudeAccounts, declaredRemoteClaudeAccounts, type DeclaredClaudeAccount } from "./claude-accounts-config.js";
import { accountForEmployee } from "./engine-account.js";
import { employeeOwnLink } from "./employee-fallback.js";
import type { FallbackExpansionMode } from "./fallback-chain-expand.js";
import {
  inheritedChain, ownTargetLink, resolveFallbackLinks,
  type FallbackChainEnv, type FallbackChainSpec,
} from "./fallback-chain.js";
import {
  fallbackLinkOf,
  type FallbackChainEntry, type FallbackChainSource, type FallbackChainSubject, type FallbackChainsResponse, type FallbackProfileOption,
} from "./fallback-chain-wire.js";
import { duplicateProblemsByChain } from "./fallback-chain-load.js";
import { ENGINE_NAMES } from "./models.js";
import { opencodeCatalogue, opencodeClones } from "./opencode-catalogue.js";
import { opencodeChainContext, opencodeChainProblems } from "./opencode-accounts.js";
import type { Employee, JinnConfig, ModelRegistry } from "./types.js";
import { opencodeAccountKeyEnvironment } from "./child-env.js";

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

/** The declared accounts a chain may name, as the editor's profile picker lists them: the local ones, then those on other hosts (marked `remote`). */
export function fallbackProfiles(config: JinnConfig): FallbackProfileOption[] {
  return [
    ...declaredClaudeAccounts(config).map((account) => ({ name: account.name, account: account.key, configDir: account.profile.dir })),
    ...declaredRemoteClaudeAccounts(config).map((account) => ({
      name: account.name, account: account.key, configDir: account.configDir, remote: { host: account.remoteHost, destination: account.destination },
    })),
  ];
}

function subjectOf(
  env: FallbackChainEnv, identity: Pick<FallbackChainSubject, "kind" | "id">, spec: FallbackChainSpec, written: readonly FallbackChainEntry[] | undefined,
  problems: readonly string[] = [],
): FallbackChainSubject {
  const [primary, ...effective] = resolveFallbackLinks(env, spec);
  return {
    ...(problems.length > 0 ? { problems: [...problems] } : {}),
    ...identity,
    primary: primary ?? null,
    configured: written === undefined ? null : written.flatMap((entry) => fallbackLinkOf(entry) ?? []),
    legacy: written?.some((entry) => typeof entry === "string") ?? false,
    effective,
  };
}

const OPEN_SCOPE = { scoped: false, remote: false };

/** The opencode links of a written chain that name a model or account opencode does not serve, or an account with no key. Advisory: the catalogue is not known at load. */
function opencodeProblems(env: FallbackChainEnv, where: string, chain: readonly FallbackChainEntry[] | undefined): string[] {
  return opencodeChainProblems(where, chain, opencodeChainContext(env.config, opencodeCatalogue(), opencodeAccountKeyEnvironment(), opencodeClones()));
}

/** An engine's default chain, `engines.<engine>.fallback`. */
export function engineSubject(env: FallbackChainEnv, engine: string): FallbackChainSubject {
  const written = (env.config.engines as unknown as Record<string, { fallback?: FallbackChainEntry[] } | undefined>)[engine]?.fallback;
  const mode: FallbackExpansionMode = engine === "claude" ? "account" : "engine";
  const own = ownTargetLink(env.config, { engine, model: defaultModel(env.config, env.registry, engine) });
  const problems = [...(duplicateProblemsByChain(env.config.engines)[`engines.${engine}.fallback`] ?? []), ...opencodeProblems(env, `engines.${engine}.fallback`, written)];
  return subjectOf(env, { kind: "engine", id: engine }, { own, ownAccount: engine, entries: written ?? [], mode, scope: OPEN_SCOPE }, written, problems);
}

/** A declared Claude account's chain, `engines.claude.accounts.<name>.fallback`. */
export function accountSubject(env: FallbackChainEnv, account: DeclaredClaudeAccount): FallbackChainSubject {
  const model = defaultModel(env.config, env.registry, "claude");
  const own = { engine: "claude", profile: account.name, ...(model ? { model } : {}) };
  const spec: FallbackChainSpec = { own, ownAccount: account.key, entries: account.fallback ?? [], mode: "account", scope: OPEN_SCOPE };
  const where = `engines.claude.accounts.${account.name}.fallback`;
  const problems = [...(duplicateProblemsByChain(env.config.engines)[where] ?? []), ...opencodeProblems(env, where, account.fallback)];
  return subjectOf(env, { kind: "account", id: account.name }, spec, account.fallback, problems);
}

/** Where an employee's chain comes from, and the account or engine that names it. */
function inheritedSource(
  config: JinnConfig, engine: string, ownAccount: string, source: FallbackChainSource | undefined,
): Pick<FallbackChainSubject, "source" | "sourceId"> {
  if (source === undefined) return { source: "employee" };
  if (source === "account") return { source, sourceId: declaredAccountByKey(config, ownAccount)?.name };
  return source === "engine" ? { source, sourceId: engine } : { source: "none" };
}

/**
 * An employee's chain: its own `fallback` when it writes one, else what its
 * account and engine give it. `scope` is what the employee's department and host
 * make of its links (department-scoped, remote), which the caller knows.
 */
export function employeeSubject(env: FallbackChainEnv, employee: Employee, scope: FallbackChainSpec["scope"]): FallbackChainSubject {
  const ownAccount = accountForEmployee(employee, employee.engine);
  const mode: FallbackExpansionMode = employee.engine === "claude" && !scope.remote ? "account" : "engine";
  const inherited = employee.fallback === undefined ? inheritedChain(env.config, employee.engine, mode, ownAccount) : undefined;
  const entries = employee.fallback ?? inherited?.entries ?? [];
  const own = employeeOwnLink(env.config, employee);
  const subject = {
    ...subjectOf(env, { kind: "employee", id: employee.name }, { own, ownAccount, claudeAccount: accountForEmployee(employee, "claude"), entries, mode, scope }, employee.fallback),
    ...inheritedSource(env.config, employee.engine, ownAccount, inherited?.source),
  };
  const problems = [...(employee.fallbackProblems ?? []), ...opencodeProblems(env, "fallback", employee.fallback)];
  return problems.length > 0 ? { ...subject, problems } : subject;
}

/** The whole response: profiles, every engine and every declared account, and the employee when one is asked for. */
export function fallbackChainsResponse(
  env: FallbackChainEnv,
  /** `registry`: the employee's own, when its links are judged elsewhere than this gateway (a remote host). */
  employee?: { employee: Employee; scope: FallbackChainSpec["scope"]; registry?: ModelRegistry },
): FallbackChainsResponse {
  const engines = ENGINE_NAMES.filter((name) => env.registry[name] !== undefined || name === "claude");
  return {
    profiles: fallbackProfiles(env.config),
    subjects: [
      ...engines.map((name) => engineSubject(env, name)),
      ...declaredClaudeAccounts(env.config).map((account) => accountSubject(env, account)),
      ...(employee ? [employeeSubject(employee.registry ? { ...env, registry: employee.registry } : env, employee.employee, employee.scope)] : []),
    ],
  };
}
