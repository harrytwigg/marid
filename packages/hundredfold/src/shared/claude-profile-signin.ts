import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  claudeKeychainService, claudeLoginHint, claudeProfileDirExists, claudeProfileMissingMessage, type ClaudeProfile,
} from "./claude-profile.js";

/**
 * Whether a Keychain item with this service name exists. Exit status only:
 * `security find-generic-password -s <service>` without `-w` or `-g` never
 * reads the secret, and its output is discarded unread.
 */
export type KeychainProbe = (service: string) => boolean;

export const securityKeychainProbe: KeychainProbe = (service) => {
  const result = spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore", timeout: 5_000 });
  return result.status === 0;
};

export interface LocalProfileCheckDeps {
  platform?: NodeJS.Platform;
  keychain?: KeychainProbe;
}

const signedIn = new Set<string>();

/**
 * Why a turn on this named profile cannot start, or undefined when it can: the
 * directory must exist and hold a login. On macOS the login is the Keychain
 * item Claude Code names after the profile (`Claude Code-credentials-<key>`);
 * elsewhere it is `<profile>/.credentials.json`. Checked by existence only —
 * the secret is never read.
 *
 * Only successes are cached, as the remote profile check does: a profile that
 * is signed in stays signed in for this check's purposes (an expired login
 * surfaces as an auth failure on the turn instead), while a refusal is
 * re-checked on the next turn, so signing in takes effect without a restart.
 */
export function verifyLocalClaudeProfile(
  profile: ClaudeProfile,
  deps: LocalProfileCheckDeps = {},
): string | undefined {
  if (!profile || signedIn.has(profile.dir)) return undefined;
  const hint = `To sign it in on this machine, ${claudeLoginHint(profile)}.`;
  if (!claudeProfileDirExists(profile)) return claudeProfileMissingMessage(profile);
  const platform = deps.platform ?? process.platform;
  const hasLogin = platform === "darwin"
    ? (deps.keychain ?? securityKeychainProbe)(claudeKeychainService(profile))
    : fileHasContent(path.join(profile.dir, ".credentials.json"));
  if (!hasLogin) return `The Claude profile \`${profile.dir}\` is not signed in. ${hint}`;
  signedIn.add(profile.dir);
  return undefined;
}

function fileHasContent(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function resetLocalProfileCheckForTests(): void {
  signedIn.clear();
}
