import { fallbackLinkOf } from "./fallback-chain-wire.js";
import type { Employee, EngineLimitsResponse, JinnConfig } from "./types.js";

/**
 * What "configured" means for the Limits surface, stated once, from the same
 * sources employee engine resolution reads: the default engine, a block under
 * `engines`, an employee's own engine or Claude profile, and any fallback chain
 * written by the config or the employee. An engine the registry merely supports
 * is not configured, so the screen never offers a card for it.
 */
export function configuredEngineNames(config: JinnConfig, employees: Iterable<Employee> = []): Set<string> {
  const names = new Set<string>();
  addName(names, config.engines.default);
  addConfigEngines(names, config.engines as unknown as Record<string, unknown>);
  for (const employee of employees) {
    addName(names, employee.engine);
    // A named profile can only be read through claude, whatever the engine line
    // says: the profile directory is a Claude Code login.
    if (employee.claudeConfigDir || employee.remoteClaudeConfigDir) addName(names, "claude");
    addLinks(names, employee.fallback);
  }
  return names;
}

/** The Limits response without engines (and their accounts) this instance does
 *  not use. `?engine=<name>` bypasses this: asking for one engine by name is an
 *  explicit request, not the dashboard's configured set. */
export function scopeEngineLimitsToConfigured(
  response: EngineLimitsResponse,
  config: JinnConfig,
  employees: Iterable<Employee> = [],
): EngineLimitsResponse {
  const names = configuredEngineNames(config, employees);
  const engines = Object.fromEntries(Object.entries(response.engines).filter(([name]) => names.has(name)));
  const scoped: EngineLimitsResponse = { ...response, engines };
  if (response.accounts) {
    const accounts = Object.fromEntries(Object.entries(response.accounts).filter(([name]) => names.has(name)));
    if (Object.keys(accounts).length > 0) scoped.accounts = accounts;
    else delete scoped.accounts;
  }
  return scoped;
}

function addConfigEngines(names: Set<string>, engines: Record<string, unknown>): void {
  for (const [name, section] of Object.entries(engines)) {
    if (name === "default" || !isRecord(section)) continue;
    addName(names, name);
    addLinks(names, section.fallback);
    addAccountLinks(names, section.accounts);
  }
}

function addAccountLinks(names: Set<string>, accounts: unknown): void {
  if (!isRecord(accounts)) return;
  for (const account of Object.values(accounts)) {
    if (isRecord(account)) addLinks(names, account.fallback);
  }
}

function addName(names: Set<string>, name: unknown): void {
  if (typeof name === "string" && name.trim()) names.add(name.trim());
}

function addLinks(names: Set<string>, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const link = fallbackLinkOf(entry);
    if (link) names.add(link.engine);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
