import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeJsonPath, resolveClaudeConfigDir, resolveJinnHome } from "./home.js";
import { validateRemoteTarget } from "./remote-target.js";
import type { Employee, RemoteExecutionConfig } from "./types.js";

/**
 * The Claude Code profile a local session runs as. `null` is the gateway's own
 * profile — whatever its `CLAUDE_CONFIG_DIR` (or `~/.claude`) is — and every
 * helper below returns exactly today's value for it, so a session without a
 * named profile sees no change at all.
 *
 * A named profile carries its canonical directory and its key. The key is the
 * suffix Claude Code itself puts on the macOS Keychain entry for that directory
 * (`Claude Code-credentials-<key>`), so a store keyed on it and the Keychain
 * agree on what "one login" is.
 */
export type ClaudeProfile = { dir: string; key: string } | null;

/** The Keychain service Claude Code stores the default profile's login under. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The one spelling of a profile directory: absolute, NFC, no `.` or `..`
 * segments, no trailing slash. Claude Code hashes the raw `CLAUDE_CONFIG_DIR`
 * string for its Keychain name, so `/a/b` and `/a/b/` are two logins; every
 * consumer (the session environment, the key, the login hint) must use the
 * string this returns, and nothing else.
 */
export function canonicalClaudeConfigDir(raw: string): string {
  const normalized = path.posix.normalize(raw.trim().normalize("NFC"));
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** First 8 hex characters of sha256 of the canonical directory, as Claude Code
 *  computes its Keychain suffix. */
export function claudeProfileKey(canonicalDir: string): string {
  return createHash("sha256").update(canonicalDir.normalize("NFC")).digest("hex").slice(0, 8);
}

export function claudeProfileFromDir(raw: string): Exclude<ClaudeProfile, null> {
  const dir = canonicalClaudeConfigDir(raw);
  return { dir, key: claudeProfileKey(dir) };
}

/**
 * Why an employee's `claudeConfigDir` cannot be used, or undefined when it can
 * (or is unset). Checked at org-scan time beside the remote-target check, so a
 * bad profile skips that employee loudly instead of failing its first turn.
 */
export function validateEmployeeClaudeConfigDir(
  employee: Pick<Employee, "claudeConfigDir" | "remoteHost">,
  jinnHome: string = resolveJinnHome(),
): string | undefined {
  const raw = employee.claudeConfigDir;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) return "claudeConfigDir must be a non-empty path";
  if (employee.remoteHost) {
    return "claudeConfigDir is for local employees; a remote employee names its profile with remoteClaudeConfigDir";
  }
  const value = raw.trim();
  if (value.startsWith("~")) return `claudeConfigDir "${value}" must be an absolute path, not home-relative`;
  if (!path.posix.isAbsolute(value)) return `claudeConfigDir "${value}" must be an absolute path`;
  const dir = canonicalClaudeConfigDir(value);
  if (forms(jinnHome).some((home) => forms(dir).some((d) => isSameOrInside(d, home)))) {
    return `claudeConfigDir "${dir}" lies inside the instance home`;
  }
  const defaultDir = resolveClaudeConfigDir();
  if (forms(defaultDir).some((d) => forms(dir).includes(d))) {
    return `claudeConfigDir "${dir}" is the gateway's own Claude profile; leave it unset to use that profile`;
  }
  return undefined;
}

/**
 * The org scan's check of where an employee runs: its remote target, then its
 * local profile, which a passing check canonicalises in place so every reader
 * sees the one spelling Claude Code hashes. Returns why the employee is refused.
 */
export function validateEmployeeTargets(employee: Employee, remote: RemoteExecutionConfig | undefined): string | undefined {
  const problem = validateRemoteTarget(employee, remote)?.error ?? validateEmployeeClaudeConfigDir(employee);
  if (!problem && employee.claudeConfigDir) employee.claudeConfigDir = canonicalClaudeConfigDir(employee.claudeConfigDir);
  return problem;
}

/** The profile an employee's LOCAL sessions run as. Remote employees name
 *  theirs with `remoteClaudeConfigDir`, which the remote engine path applies. */
export function resolveEmployeeClaudeProfile(
  employee: Pick<Employee, "claudeConfigDir" | "remoteHost"> | null | undefined,
): ClaudeProfile {
  if (!employee || employee.remoteHost) return null;
  const raw = typeof employee.claudeConfigDir === "string" ? employee.claudeConfigDir.trim() : "";
  return raw ? claudeProfileFromDir(raw) : null;
}

/** The employee wire's read-only view of its profile: null for the default. */
export function claudeProfileWire(
  employee: Pick<Employee, "claudeConfigDir" | "remoteHost">,
): { path: string; key: string } | null {
  const profile = resolveEmployeeClaudeProfile(employee);
  return profile ? { path: profile.dir, key: profile.key } : null;
}

export function claudeConfigDirFor(profile: ClaudeProfile): string {
  return profile ? profile.dir : resolveClaudeConfigDir();
}

/** Claude Code's global config for the profile: inside a named profile's
 *  directory, as it is whenever `CLAUDE_CONFIG_DIR` is set. */
export function claudeJsonPathFor(profile: ClaudeProfile): string {
  return profile ? path.join(profile.dir, ".claude.json") : claudeJsonPath();
}

export function claudeProjectsDirFor(profile: ClaudeProfile): string {
  return path.join(claudeConfigDirFor(profile), "projects");
}

export function claudeKeychainService(profile: ClaudeProfile): string {
  return profile ? `${CLAUDE_KEYCHAIN_SERVICE}-${profile.key}` : CLAUDE_KEYCHAIN_SERVICE;
}

/** How an operator signs a profile in, naming the canonical directory exactly. */
export function claudeLoginHint(profile: Exclude<ClaudeProfile, null>): string {
  return `run \`CLAUDE_CONFIG_DIR=${profile.dir} claude\`, then \`/login\``;
}

/**
 * Point a child environment at the profile. A named profile sets
 * `CLAUDE_CONFIG_DIR` and drops an inherited `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
 * which would otherwise decide the Keychain name in its place. The default
 * profile leaves the environment exactly as it was.
 */
export function applyClaudeProfileEnv(env: Record<string, string>, profile: ClaudeProfile): Record<string, string> {
  if (!profile) return env;
  env.CLAUDE_CONFIG_DIR = profile.dir;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return env;
}

/** Every named profile directory on the roster, registered by the gateway at
 *  boot. The file-read policy refuses their auth files as it does the default
 *  profile's. */
let namedProfileDirs: () => readonly string[] = () => [];

export function registerClaudeProfileDirs(source: () => readonly string[]): void {
  namedProfileDirs = source;
}

/** The default profile's directory plus every named one. */
export function protectedClaudeConfigDirs(): string[] {
  let named: readonly string[] = [];
  try {
    named = namedProfileDirs();
  } catch { /* a roster that cannot be read still protects the default profile */ }
  return [resolveClaudeConfigDir(), ...named];
}

function forms(p: string): string[] {
  const resolved = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  try {
    const real = fs.realpathSync.native(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

function isSameOrInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
