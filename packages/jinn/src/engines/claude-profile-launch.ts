import { operatorSettingsCarry } from "../shared/claude-profile-settings.js";
import { claudeJsonPathFor, type ClaudeProfile } from "../shared/claude-profile.js";
import { seedTrust, writeSessionSettings } from "../shared/claude-settings.js";
import { logger } from "../shared/logger.js";
import { CLAUDE_LIMITS_DIR, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";

/**
 * The per-turn `--settings` file for a Claude session. Local and remote
 * sessions both write it (the cold-spawn cleanup is keyed on it); a named
 * local profile also carries the operator's keys that profile cannot read
 * from its own directory (claude-profile-settings.ts).
 */
export function writeClaudeSessionSettings(jinnSessionId: string, profile: ClaudeProfile | undefined): string {
  return writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
    sessionId: jinnSessionId,
    relayScript: HOOK_RELAY_SCRIPT,
    statusLineDir: CLAUDE_LIMITS_DIR,
    carry: operatorSettingsCarry(profile ?? null),
  });
}

const seeded = new Set<string>();

/**
 * Folder trust for a named profile, seeded before its first spawn in `cwd`.
 * The boot-time seed covers only the gateway's own profile; without this the
 * trust dialog sits in front of an unattended PTY and the first turn hangs.
 * Cached per profile and cwd, and only on success, so a failed write is retried
 * by the next spawn rather than remembered.
 */
export function ensureClaudeProfileTrust(profile: ClaudeProfile | undefined, cwd: string): void {
  if (!profile) return;
  const key = `${profile.key}\0${cwd}`;
  if (seeded.has(key)) return;
  try {
    seedTrust(claudeJsonPathFor(profile), cwd);
    seeded.add(key);
  } catch (err) {
    logger.warn(`Could not seed folder trust for ${cwd} in the Claude profile ${profile.dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function resetClaudeProfileTrustForTests(): void {
  seeded.clear();
}
