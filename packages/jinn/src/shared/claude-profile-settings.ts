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
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Could not read ${settingsFile} to carry its settings into a session on ${profile.dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return { ...attributionOf(data), ...preToolUseOf(data), ...consentOf(data) };
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
