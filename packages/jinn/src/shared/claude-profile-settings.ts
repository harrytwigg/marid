import fs from "node:fs";
import path from "node:path";
import type { ClaudeProfile } from "./claude-profile.js";
import { resolveClaudeConfigDir } from "./home.js";
import { logger } from "./logger.js";

/**
 * The operator's `settings.json` keys a gateway session relies on without
 * carrying them itself. The default profile reads them from the operator's own
 * file; a named profile reads its own directory's file instead, so for it the
 * gateway copies them into the session's `--settings`:
 *
 * - `attribution`: no Co-Authored-By trailer or "Generated with" line in
 *   commits and PRs;
 * - `hooks.PreToolUse`: the operator's own guards (merged after the gateway's
 *   hook relay, never replacing it);
 * - `skipDangerousModePermissionPrompt`: without it the bypass-permissions
 *   consent dialog sits in front of an unattended PTY.
 */
export interface OperatorSettingsCarry {
  attribution?: unknown;
  preToolUse?: Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string }> }>;
  skipDangerousModePermissionPrompt?: boolean;
}

/** The carry for a session on `profile`; undefined for the default profile,
 *  whose sessions already read the operator's file. */
export function operatorSettingsCarry(
  profile: ClaudeProfile,
  settingsFile: string = path.join(resolveClaudeConfigDir(), "settings.json"),
): OperatorSettingsCarry | undefined {
  if (!profile) return undefined;
  const data = readOperatorSettings(settingsFile, profile.dir);
  return data ? { ...attributionOf(data), ...preToolUseOf(data), ...consentOf(data) } : {};
}

/**
 * The carry for a remote session on a named profile (`claudeConfigDir`):
 * undefined for the remote user's default profile, as locally.
 *
 * Only the bypass consent travels, and only when the operator gave it. The
 * PreToolUse hooks name commands on the gateway's host, and a carried `false`
 * would outrank the profile's own consent (`--settings` beats the profile's
 * `settings.json`) and could only put the dialog back in front of the PTY.
 */
export function remoteOperatorSettingsCarry(
  claudeConfigDir: string | undefined,
  settingsFile: string = path.join(resolveClaudeConfigDir(), "settings.json"),
): OperatorSettingsCarry | undefined {
  if (!claudeConfigDir) return undefined;
  const data = readOperatorSettings(settingsFile, claudeConfigDir);
  return data?.skipDangerousModePermissionPrompt === true ? { skipDangerousModePermissionPrompt: true } : {};
}

function readOperatorSettings(settingsFile: string, profileDir: string): Record<string, unknown> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Could not read ${settingsFile} to carry its settings into a session on ${profileDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

function attributionOf(data: Record<string, unknown>): OperatorSettingsCarry {
  return data.attribution === undefined ? {} : { attribution: data.attribution };
}

function preToolUseOf(data: Record<string, unknown>): OperatorSettingsCarry {
  const hooks = data.hooks as Record<string, unknown> | undefined;
  const preToolUse = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse as OperatorSettingsCarry["preToolUse"] : undefined;
  return preToolUse?.length ? { preToolUse } : {};
}

function consentOf(data: Record<string, unknown>): OperatorSettingsCarry {
  const value = data.skipDangerousModePermissionPrompt;
  return typeof value === "boolean" ? { skipDangerousModePermissionPrompt: value } : {};
}
