import { accountNames, declaredRemoteAccountByName } from "./claude-accounts-config.js";
import { resolveEmployeeClaudeProfile } from "./claude-profile.js";
import { claudeAccountKey, remoteClaudeAccountKey } from "./engine-account.js";
import { ownTargetLink } from "./fallback-chain-links.js";
import { fallbackChainProblems, fallbackLinkOf, type FallbackLink } from "./fallback-chain-wire.js";
import type { DuplicateTolerance } from "./fallback-chain-load.js";
import { logger } from "./logger.js";
import { ENGINE_NAMES } from "./models.js";
import { isRemoteTarget, resolveRemoteClaudeConfigDir, sshDestination } from "./remote-target.js";
import type { Employee, JinnConfig } from "./types.js";

/**
 * An employee's own `fallback` (docs/fallback-chains.md): a list of
 * `{engine, profile?, model?}` mappings that replaces the account's and the
 * engine's chain for that employee's sessions. Absent inherits; `[]` is no
 * fallback. Only the object form is written here: the legacy strings stand for
 * "that target and its own chain", which an employee's chain has no use for.
 */

/** The parts of an employee its own target is made of. */
type EmployeeTarget = Pick<Employee, "engine" | "model" | "claudeConfigDir" | "remoteHost" | "remoteUser" | "remoteClaudeConfigDir">;

/** The Claude account an employee's own target runs as: a local profile's, or a remote login's (with the instance-wide profile directory applied). */
function ownAccountKey(config: JinnConfig, employee: EmployeeTarget): string {
  if (!isRemoteTarget(employee)) return claudeAccountKey(resolveEmployeeClaudeProfile(employee));
  return remoteClaudeAccountKey(employee, resolveRemoteClaudeConfigDir(employee, config.remote));
}

/** The target an employee's chain falls back from: its engine, its model and, for a Claude profile (local, or a remote login) that is a declared account, that account's name. */
export function employeeOwnLink(config: JinnConfig, employee: EmployeeTarget): FallbackLink {
  const account = employee.engine === "claude" ? ownAccountKey(config, employee) : undefined;
  return ownTargetLink(config, { engine: employee.engine, model: employee.model, ...(account === undefined ? {} : { account }) });
}

/** Problems with an employee's chain (empty = valid), in the wire module's words. `config` is what the profile names are checked against; without it only the shapes are. `onDuplicate` may tolerate a repeated target (the loader does; a write does not). */
export function employeeFallbackProblems(config: JinnConfig | undefined, employee: EmployeeTarget, chain: unknown, onDuplicate?: DuplicateTolerance): string[] {
  if (!Array.isArray(chain)) return ["fallback must be a list of fallback targets"];
  const strings = chain.flatMap((entry, index) => typeof entry === "string"
    ? [`fallback[${index}] must be a mapping with engine, profile and model: the engine-name and claude:<name> strings are for engine and account chains`] : []);
  const named = chain.map((entry) => fallbackLinkOf(entry)?.profile).filter((profile): profile is string => profile !== undefined);
  const profiles = config ? accountNames(config.engines) : new Set(named);
  const ctx = { engines: ENGINE_NAMES, profiles, onDuplicate };
  if (!config) return [...strings, ...fallbackChainProblems("fallback", chain, ctx)];
  // A link with no model runs the employee's own model on its own engine, so it is the own target as well: check both spellings.
  // A remote employee on a declared account also reaches its own login by naming no profile at all.
  const self = employeeOwnLink(config, employee);
  const { model: _model, ...modelless } = self;
  const spellings: FallbackLink[] = [self, modelless];
  if (isRemoteTarget(employee) && self.profile !== undefined) {
    const { profile: _profile, ...unprofiled } = self;
    spellings.push(unprofiled, { engine: self.engine });
  }
  const problems = spellings.flatMap((spelling) => fallbackChainProblems("fallback", chain, { ...ctx, self: spelling }));
  return [...new Set([...strings, ...problems, ...hostProfileProblems(config, employee, chain)])];
}

/** Where a profile link may run: a remote employee falls back only to an account declared on its own `user@host`, a local one to no remote account. Unknown names are the wire module's to refuse. */
function hostProfileProblems(config: JinnConfig, employee: EmployeeTarget, chain: unknown[]): string[] {
  return chain.flatMap((entry, index) => {
    const link = fallbackLinkOf(entry);
    if (link?.engine !== "claude" || link.profile === undefined) return [];
    const at = `fallback[${index}]: profile "${link.profile}"`;
    const remote = declaredRemoteAccountByName(config, link.profile);
    const local = accountNames(config.engines).has(link.profile) && !remote;
    if (!isRemoteTarget(employee)) {
      return remote ? [`${at} is declared on ${remote.destination}; a local employee falls back only to a local account`] : [];
    }
    const destination = sshDestination(employee);
    if (local) return [`${at} is a local profile; a remote employee falls back only to an account declared with remoteHost ${employee.remoteHost}`];
    return remote && remote.destination !== destination ? [`${at} is declared on ${remote.destination}, not ${destination}`] : [];
  });
}

/** A valid chain as the links it holds. */
function linksOf(chain: unknown[]): FallbackLink[] {
  return chain.flatMap((entry) => fallbackLinkOf(entry) ?? []);
}

/** What changing an employee's engine or model does to the chain it already holds: the problems the new own target gives it, none when it holds no chain or the target stays. */
export function storedFallbackProblems(config: JinnConfig, current: EmployeeTarget & { fallback?: FallbackLink[] }, next: EmployeeTarget): string[] {
  if (!current.fallback || (current.engine === next.engine && current.model === next.model)) return [];
  return employeeFallbackProblems(config, next, current.fallback);
}

/** A PATCH's `fallback`: null removes it (inherit), a valid list is written as links, anything else is refused with the reasons. */
export function employeeFallbackUpdate(
  config: JinnConfig, employee: EmployeeTarget, value: unknown,
): { ok: true; value: FallbackLink[] | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  const problems = employeeFallbackProblems(config, employee, value);
  return problems.length > 0 ? { ok: false, error: problems.join("; ") } : { ok: true, value: linksOf(value as unknown[]) };
}

/**
 * An employee YAML's `fallback`, as the roster holds it. Absent (or an empty key)
 * inherits. A chain that repeats a target is kept, as in config.yaml: it is warned
 * about naming the employee, the expansion lists the target once, and the repeat is
 * kept as `problems`. Any other invalid chain is left out and its problems are kept,
 * so the employee still loads and inherits and the typo does not vanish silently
 * (a typo in a chain must not take a roster entry away; the chain is advice about a
 * limit, not a boundary like a remote target).
 */
export function loadEmployeeFallback(
  raw: unknown, employee: EmployeeTarget & { name: string }, config: JinnConfig | undefined, source: string,
): { fallback?: FallbackLink[]; problems?: string[] } {
  if (raw === undefined || raw === null) return {};
  const seen = new Set<string>();
  const problems = employeeFallbackProblems(config, employee, raw, ({ problem }) => { seen.add(problem); return true; });
  const repeats = [...seen];
  if (problems.length > 0) {
    logger.warn(`Ignoring the fallback of employee ${employee.name} (${source}), which inherits its account's or engine's chain instead: ${problems.join("; ")}`);
    return { problems: [...problems, ...repeats] };
  }
  if (repeats.length > 0) logger.warn(`Employee ${employee.name} (${source}): ${repeats.join("; ")}; the repeat is ignored. Remove it from the employee file.`);
  return { fallback: linksOf(raw as unknown[]), ...(repeats.length > 0 ? { problems: repeats } : {}) };
}
