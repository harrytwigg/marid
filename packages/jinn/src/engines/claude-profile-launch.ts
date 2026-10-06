import { operatorSettingsCarry } from "../shared/claude-profile-settings.js";
import { claudeJsonPathFor, claudeProfileDirExists, claudeProfileMissingMessage, type ClaudeProfile } from "../shared/claude-profile.js";
import { seedTrust, writeSessionSettings } from "../shared/claude-settings.js";
import { remoteAccountForTarget } from "../shared/engine-account.js";
import type { ClaudeResetSource } from "../shared/engine-reset-times.js";
import { logger } from "../shared/logger.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import type { RemoteTarget } from "../shared/types.js";
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
  // Never create a named profile's directory; a missing one is refused as "does not exist".
  if (!claudeProfileDirExists(profile)) return;
  try {
    seedTrust(claudeJsonPathFor(profile), cwd, { createDir: false });
    seeded.add(key);
  } catch (err) {
    logger.warn(`Could not seed folder trust for ${cwd} in the Claude profile ${profile.dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Refuse to launch the CLI under a named profile whose directory is missing: Claude Code
 * creates its config dir on first run, and the gateway never creates a named profile's
 * directory. A turn is refused earlier in preflight (FR-054); this covers the launches
 * that have no preflight, the terminal view and a fork.
 */
export function assertClaudeProfileDirExists(profile: ClaudeProfile | undefined): void {
  if (profile && !claudeProfileDirExists(profile)) throw new Error(claudeProfileMissingMessage(profile));
}

export function resetClaudeProfileTrustForTests(): void {
  seeded.clear();
}

/**
 * Whose usage answers "when does this limit reset" for a turn: a remote
 * session's own login (its last reading over SSH), else the local profile the
 * turn ran as, the default account when it named none (FR-071, FR-072).
 */
export function claudeResetSource(opts: Partial<RemoteTarget> & { claudeProfile?: ClaudeProfile }): ClaudeResetSource {
  if (isRemoteTarget(opts)) return { remoteAccount: remoteAccountForTarget(opts) };
  return { profile: opts.claudeProfile ?? null };
}
