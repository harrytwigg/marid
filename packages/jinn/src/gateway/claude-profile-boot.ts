import { declaredClaudeAccounts } from "../shared/claude-accounts-config.js";
import { registerClaudeProfileDirs } from "../shared/claude-profile.js";
import { seedTrust } from "../shared/claude-settings.js";
import {
  accountForEmployee, registerEmployeeAccountResolver, registerRemoteAccountDefaults, registerSessionAccountResolver,
} from "../shared/engine-account.js";
import { registerAccountRoster, registerRemoteAccountReader } from "../shared/engine-limits-accounts.js";
import { claudeJsonPath } from "../shared/home.js";
import { remoteAccountReader } from "../engines/remote-account-usage.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import type { JinnConfig } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { currentClaudeAccount } from "../sessions/session-account.js";
import { orgRegistry } from "./org-registry.js";

/**
 * Gateway boot for Claude profiles and accounts: the default profile's folder
 * trust (named profiles are seeded lazily, before their first spawn), and the
 * roster lookups the shared layer cannot make for itself — which account an
 * employee and a session run on (so status-line snapshots, thread ids and
 * health land on the right account), the instance `remote` block a remote
 * account is keyed under, and which profile directories the file-read policy
 * protects.
 */
export function bootClaudeProfiles(getConfig: () => JinnConfig): void {
  // Seed trust for the Jinn project dir so interactive Claude doesn't prompt.
  try {
    seedTrust(claudeJsonPath(), JINN_HOME);
  } catch (err) {
    logger.warn(`Failed to seed Claude trust: ${err instanceof Error ? err.message : err}`);
  }
  registerRemoteAccountDefaults(() => getConfig().remote);
  registerAccountRoster(() => orgRegistry().values());
  registerRemoteAccountReader(remoteAccountReader);
  registerEmployeeAccountResolver((name) => {
    const employee = orgRegistry().get(name);
    return employee ? accountForEmployee(employee, "claude") : undefined;
  });
  registerSessionAccountResolver((jinnSessionId) => {
    const session = getSession(jinnSessionId);
    return session ? currentClaudeAccount(session) : undefined;
  });
  registerClaudeProfileDirs(() => [
    ...[...orgRegistry().values()].flatMap((employee) => (employee.claudeConfigDir && !employee.remoteHost ? [employee.claudeConfigDir] : [])),
    ...declaredClaudeAccounts(getConfig()).map((account) => account.profile.dir),
  ]);
}
