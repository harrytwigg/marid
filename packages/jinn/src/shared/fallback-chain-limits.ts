import { readClaudeUsageHistory, usageHistoryPath } from "./claude-usage-history.js";
import { declaredClaudeAccounts } from "./claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import type { FallbackLimitReadings } from "./fallback-chain-health.js";
import type { JinnConfig } from "./types.js";

/**
 * The latest limits reading of each Claude account a chain may name, from the
 * usage history the Claude collector already keeps. Read from disk and never
 * probed: showing a chain must not cost a call to a provider, and an account
 * nothing has read yet simply has no reading.
 */
export function latestLimitReadings(config: JinnConfig, extraAccounts: Iterable<string> = []): FallbackLimitReadings {
  const accounts = new Set([DEFAULT_CLAUDE_ACCOUNT, ...declaredClaudeAccounts(config).map((account) => account.key), ...extraAccounts]);
  const readings: FallbackLimitReadings = {};
  for (const account of accounts) {
    const history = readClaudeUsageHistory(0, usageHistoryPath(account));
    readings[account] = history[history.length - 1];
  }
  return readings;
}
