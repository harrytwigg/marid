import fs from "node:fs";
import { readClaudeUsageHistory, usageHistoryPath, type UsageSample } from "./claude-usage-history.js";
import { declaredClaudeAccounts, declaredRemoteClaudeAccounts } from "./claude-accounts-config.js";
import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import type { FallbackLimitReadings } from "./fallback-chain-health.js";
import type { Employee, JinnConfig } from "./types.js";

/**
 * The latest limits reading of each Claude account a chain may name, from the
 * usage history the Claude collector already keeps. Read from disk and never
 * probed: showing a chain must not cost a call to a provider, and an account
 * nothing has read yet simply has no reading.
 */
/** The newest sample per history file, kept while the file is unchanged: a session GET reads these on every call, and the file holds a week of samples. */
const newest = new Map<string, { stamp: string; sample: UsageSample | undefined }>();

function newestSample(account: string): UsageSample | undefined {
  const file = usageHistoryPath(account);
  let stamp = "";
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
  const cached = newest.get(file);
  if (cached?.stamp === stamp) return cached.sample;
  const history = readClaudeUsageHistory(0, file);
  const sample = history[history.length - 1];
  newest.set(file, { stamp, sample });
  return sample;
}

export function latestLimitReadings(config: JinnConfig, extraAccounts: Iterable<string> = []): FallbackLimitReadings {
  const accounts = new Set([DEFAULT_CLAUDE_ACCOUNT, ...declaredClaudeAccounts(config).map((account) => account.key), ...declaredRemoteClaudeAccounts(config).map((account) => account.key), ...extraAccounts]);
  const readings: FallbackLimitReadings = {};
  for (const account of accounts) readings[account] = newestSample(account);
  return readings;
}

/** The accounts an employee's chain is judged on: the one its turns on `engine` run as, and the Claude login a Claude link in its chain runs as (the two differ for an employee off Claude). */
export function employeeLimitAccounts(employee: Employee | undefined, engine: string): string[] {
  return [...new Set([accountForEmployee(employee, engine), accountForEmployee(employee, "claude")])];
}
