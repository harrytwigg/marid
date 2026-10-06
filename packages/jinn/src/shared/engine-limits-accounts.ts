import path from "node:path";
import { declaredClaudeAccounts } from "./claude-accounts-config.js";
import { resolveEmployeeClaudeProfile, type ClaudeProfile } from "./claude-profile.js";
import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { isEngineExhausted, readEngineHealth, recordExhaustedWindows, type EngineHealthReading } from "./engine-health.js";
import { collectClaudeLimits } from "./engine-limits-claude.js";
import { isRemoteTarget, resolveRemoteClaudeConfigDir, sshDestination } from "./remote-target.js";
import type { Employee, EngineLimitEngineSnapshot, JinnConfig } from "./types.js";

/**
 * Limits per Claude account (spec FR-071 to FR-073). The default account is
 * read exactly as before and stays `engines.claude` on the wire; every other
 * account the roster or config uses gets its own reading, beside it, in an
 * additive `accounts` list. With one account the list is omitted, so a
 * single-account instance's response is unchanged (FR-078).
 */

export type AccountLocation = { kind: "local" } | { kind: "remote"; host: string };

/** One Claude account the gateway reads, with the employees on it. */
export interface ClaudeAccountInfo {
  key: string;
  label: string;
  location: AccountLocation;
  /** A local named profile; null for the default account and remote logins. */
  profile: ClaudeProfile;
  /** A remote login: where to read it, and the profile directory on that host. */
  remote?: { destination: string; configDir?: string };
  employees: string[];
}

export interface EngineLimitAccountSnapshot extends EngineLimitEngineSnapshot {
  account: string;
  label: string;
  location: AccountLocation;
  employees: string[];
  /** No live reading: an expired token, a locked remote Keychain, or a host asleep (FR-075a). */
  noReading?: true;
  /** The remote host did not answer; the windows are its last reading, if any (FR-072). */
  hostUnreachable?: true;
  /** Health records the account at its limit. */
  exhausted?: { until?: string };
}

function usesClaude(employee: Employee, config: JinnConfig): boolean {
  return (employee.engine ?? config.engines.default) === "claude";
}

function describe(employee: Employee, config: JinnConfig, key: string, names: Map<string, string>): Omit<ClaudeAccountInfo, "employees"> {
  if (isRemoteTarget(employee)) {
    const configDir = resolveRemoteClaudeConfigDir(employee, config.remote);
    const destination = sshDestination(employee);
    return {
      key, label: configDir ? `${destination} (${path.posix.basename(configDir)})` : destination,
      location: { kind: "remote", host: employee.remoteHost }, profile: null,
      remote: { destination, ...(configDir ? { configDir } : {}) },
    };
  }
  const profile = resolveEmployeeClaudeProfile(employee);
  return { key, label: names.get(key) ?? (profile ? path.basename(profile.dir) : "claude"), location: { kind: "local" }, profile };
}

/**
 * Every Claude account in use: the default first, then each account an
 * employee runs on or config declares, by label. Employees on another engine
 * play no part.
 */
export function claudeAccountsFor(employees: Iterable<Employee>, config: JinnConfig): ClaudeAccountInfo[] {
  const declared = declaredClaudeAccounts(config);
  const names = new Map(declared.map((account) => [account.key, account.name]));
  const byKey = new Map<string, ClaudeAccountInfo>([[DEFAULT_CLAUDE_ACCOUNT, {
    key: DEFAULT_CLAUDE_ACCOUNT, label: "claude", location: { kind: "local" }, profile: null, employees: [],
  }]]);
  for (const account of declared) {
    byKey.set(account.key, { key: account.key, label: account.name, location: { kind: "local" }, profile: account.profile, employees: [] });
  }
  for (const employee of employees) {
    if (!usesClaude(employee, config)) continue;
    const key = accountForEmployee(employee, "claude");
    const entry = byKey.get(key) ?? { ...describe(employee, config, key, names), employees: [] };
    entry.employees.push(employee.name);
    byKey.set(key, entry);
  }
  const [first, ...rest] = byKey.values();
  return [first, ...rest.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))];
}

/** The roster the gateway registers at boot; the shared layer cannot read it. */
let roster: () => Iterable<Employee> = () => [];

export function registerAccountRoster(source: () => Iterable<Employee>): void {
  roster = source;
}

export function rosterClaudeAccounts(config: JinnConfig): ClaudeAccountInfo[] {
  let employees: Iterable<Employee> = [];
  try {
    employees = roster();
  } catch { /* an unreadable roster leaves the default account alone */ }
  return claudeAccountsFor(employees, config);
}

/** Reads a remote account over SSH (engines/remote-account-usage.ts, registered
 *  at boot). `reachable: false` means the host did not answer and the snapshot
 *  is its last reading. */
export type RemoteAccountReader = (config: JinnConfig, account: ClaudeAccountInfo) => Promise<{ snapshot: EngineLimitEngineSnapshot; reachable: boolean }>;
let remoteReader: RemoteAccountReader | undefined;

export function registerRemoteAccountReader(reader: RemoteAccountReader | undefined): void {
  remoteReader = reader;
}

/** A reading the walk would hold on: nothing live, or a status-line snapshot gone stale. */
export function hasNoLiveReading(snapshot: EngineLimitEngineSnapshot): boolean {
  if (snapshot.status === "live") return false;
  return !(snapshot.status === "snapshot" && !snapshot.stale);
}

function decorate(info: ClaudeAccountInfo, snapshot: EngineLimitEngineSnapshot, health: EngineHealthReading, reachable: boolean): EngineLimitAccountSnapshot {
  const record = health[info.key];
  return {
    ...snapshot,
    account: info.key,
    label: info.label,
    location: info.location,
    employees: info.employees,
    ...(hasNoLiveReading(snapshot) || !reachable ? { noReading: true as const } : {}),
    ...(reachable ? {} : { hostUnreachable: true as const }),
    ...(isEngineExhausted(health, info.key) ? { exhausted: record?.until ? { until: record.until } : {} } : {}),
  };
}

async function readAccount(config: JinnConfig, info: ClaudeAccountInfo): Promise<{ snapshot: EngineLimitEngineSnapshot; reachable: boolean }> {
  if (info.location.kind === "local") return { snapshot: await collectClaudeLimits(config, info.profile), reachable: true };
  if (!remoteReader) {
    return { snapshot: { name: "claude", available: false, status: "unsupported", source: "remote account", refreshedAt: new Date().toISOString(), models: [] }, reachable: false };
  }
  return remoteReader(config, info);
}

/**
 * Every Claude account's reading, the default's taken from `defaultSnapshot`
 * (already read for `engines.claude`). Undefined with a single account. A
 * fully spent window is written through to that account's health record, as
 * the default account's is.
 */
export async function collectClaudeAccounts(
  config: JinnConfig,
  defaultSnapshot: EngineLimitEngineSnapshot,
  accounts: ClaudeAccountInfo[] = rosterClaudeAccounts(config),
): Promise<EngineLimitAccountSnapshot[] | undefined> {
  if (accounts.length <= 1) return undefined;
  const readings = await Promise.all(accounts.map(async (info) => {
    if (info.key === DEFAULT_CLAUDE_ACCOUNT) return { info, snapshot: defaultSnapshot, reachable: true };
    const { snapshot, reachable } = await readAccount(config, info);
    if (reachable) recordExhaustedWindows(info.key, snapshot.windows);
    return { info, snapshot, reachable };
  }));
  const health = readEngineHealth();
  return readings.map(({ info, snapshot, reachable }) => decorate(info, snapshot, health, reachable));
}
