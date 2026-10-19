import { accountNames } from "./claude-accounts-config.js";
import { resolveEmployeeClaudeProfile } from "./claude-profile.js";
import { claudeAccountKey } from "./engine-account.js";
import { ownTargetLink } from "./fallback-chain-links.js";
import { fallbackChainProblems, fallbackLinkOf, type FallbackLink } from "./fallback-chain-wire.js";
import { logger } from "./logger.js";
import { ENGINE_NAMES } from "./models.js";
import type { Employee, JinnConfig } from "./types.js";

/**
 * An employee's own `fallback` (docs/fallback-chains.md): a list of
 * `{engine, profile?, model?}` mappings that replaces the account's and the
 * engine's chain for that employee's sessions. Absent inherits; `[]` is no
 * fallback. Only the object form is written here: the legacy strings stand for
 * "that target and its own chain", which an employee's chain has no use for.
 */

/** The parts of an employee its own target is made of. */
type EmployeeTarget = Pick<Employee, "engine" | "model" | "claudeConfigDir" | "remoteHost">;

/** The target an employee's chain falls back from: its engine, its model and, for a local Claude profile that is a declared account, that account's name. */
export function employeeOwnLink(config: JinnConfig, employee: EmployeeTarget): FallbackLink {
  const account = employee.engine === "claude" ? claudeAccountKey(resolveEmployeeClaudeProfile(employee)) : undefined;
  return ownTargetLink(config, { engine: employee.engine, model: employee.model, ...(account === undefined ? {} : { account }) });
}

/** Problems with an employee's chain (empty = valid), in the wire module's words. `config` is what the profile names are checked against; without it only the shapes are. */
export function employeeFallbackProblems(config: JinnConfig | undefined, employee: EmployeeTarget, chain: unknown): string[] {
  if (!Array.isArray(chain)) return ["fallback must be a list of fallback targets"];
  const stringEntry = chain.findIndex((entry) => typeof entry === "string");
  if (stringEntry >= 0) return [`fallback[${stringEntry}] must be a mapping with engine, profile and model: the engine-name and claude:<name> strings are for engine and account chains`];
  const named = chain.map((entry) => fallbackLinkOf(entry)?.profile).filter((profile): profile is string => profile !== undefined);
  const profiles = config ? accountNames(config.engines) : new Set(named);
  const ctx = { engines: ENGINE_NAMES, profiles };
  if (!config) return fallbackChainProblems("fallback", chain, ctx);
  // A link with no model runs the employee's own model on its own engine, so it is the own target as well: check both spellings.
  const self = employeeOwnLink(config, employee);
  const { model: _model, ...modelless } = self;
  return [...new Set([...fallbackChainProblems("fallback", chain, { ...ctx, self }), ...fallbackChainProblems("fallback", chain, { ...ctx, self: modelless })])];
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
 * inherits. An invalid chain is left out and its problems are kept: they are
 * logged naming the employee and carried on the roster entry (`fallbackProblems`,
 * shown with the employee's chain), so the employee still loads and inherits and
 * the typo does not vanish silently. A typo in a chain must not take a roster
 * entry away, and the chain is advice about a limit, not a boundary like a
 * remote target.
 */
export function loadEmployeeFallback(
  raw: unknown, employee: EmployeeTarget & { name: string }, config: JinnConfig | undefined, source: string,
): { fallback?: FallbackLink[]; problems?: string[] } {
  if (raw === undefined || raw === null) return {};
  const problems = employeeFallbackProblems(config, employee, raw);
  if (problems.length === 0) return { fallback: linksOf(raw as unknown[]) };
  logger.warn(`Ignoring the fallback of employee ${employee.name} (${source}), which inherits its account's or engine's chain instead: ${problems.join("; ")}`);
  return { problems };
}
