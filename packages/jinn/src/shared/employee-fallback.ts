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
  const self = config ? employeeOwnLink(config, employee) : undefined;
  return fallbackChainProblems("fallback", chain, { engines: ENGINE_NAMES, profiles, ...(self ? { self } : {}) });
}

/** A valid chain as the links it holds. */
function linksOf(chain: unknown[]): FallbackLink[] {
  return chain.flatMap((entry) => fallbackLinkOf(entry) ?? []);
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
 * inherits. An invalid chain is logged and left out, so the employee still
 * loads and inherits: a typo in a chain must not take a roster entry away, and
 * the chain is advice about a limit, not a boundary like a remote target.
 */
export function loadEmployeeFallback(raw: unknown, employee: EmployeeTarget, config: JinnConfig | undefined, source: string): FallbackLink[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const problems = employeeFallbackProblems(config, employee, raw);
  if (problems.length > 0) {
    logger.warn(`Ignoring the fallback of employee file ${source}, which inherits instead: ${problems.join("; ")}`);
    return undefined;
  }
  return linksOf(raw as unknown[]);
}
