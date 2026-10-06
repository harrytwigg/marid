import { registerClaudeProfileDirs } from "../shared/claude-profile.js";
import { seedTrust } from "../shared/claude-settings.js";
import { accountForEmployee, registerSessionAccountResolver } from "../shared/engine-account.js";
import { claudeJsonPath } from "../shared/home.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { getSession } from "../sessions/registry.js";
import { orgRegistry } from "./org-registry.js";

/**
 * Gateway boot for Claude profiles: the default profile's folder trust (named
 * profiles are seeded lazily, before their first spawn), and the two roster
 * lookups the shared layer cannot make for itself — which account a session's
 * status-line snapshots belong to, and which profile directories the file-read
 * policy protects.
 */
export function bootClaudeProfiles(): void {
  // Seed trust for the Jinn project dir so interactive Claude doesn't prompt.
  try {
    seedTrust(claudeJsonPath(), JINN_HOME);
  } catch (err) {
    logger.warn(`Failed to seed Claude trust: ${err instanceof Error ? err.message : err}`);
  }
  registerSessionAccountResolver((jinnSessionId) => {
    const session = getSession(jinnSessionId);
    if (!session) return undefined;
    return accountForEmployee(session.employee ? orgRegistry().get(session.employee) : undefined, session.engine);
  });
  registerClaudeProfileDirs(() => [...orgRegistry().values()]
    .flatMap((employee) => (employee.claudeConfigDir && !employee.remoteHost ? [employee.claudeConfigDir] : [])));
}
