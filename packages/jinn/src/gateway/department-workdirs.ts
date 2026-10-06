import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveJinnHome } from "../shared/paths.js";
import { employeeClaudeConfigDirs } from "./org-yaml-files.js";

/**
 * Working-directory validation for a department (FR-033). A department's working
 * directories are where a later phase lets its scoped sessions read and write, so a
 * directory that is, contains or sits inside the places the gateway keeps its own
 * state or the operator keeps credentials is refused here, at the edge.
 */

/** The generated per-department directories live beside the home, never inside it. */
export function departmentStageRoot(): string {
  return path.join(path.dirname(resolveJinnHome()), ".jinn-departments");
}

/** Profile directories employees run their Claude sessions as (`claudeConfigDir`). */
export interface WorkdirOptions {
  claudeConfigDirs?: readonly string[];
}

/** The options every department read and write judges working directories with: each employee's Claude profile, from the YAML under `org/`. */
export function departmentWorkdirOptions(home: string = resolveJinnHome()): WorkdirOptions {
  return { claudeConfigDirs: employeeClaudeConfigDirs(path.join(home, "org")) };
}

/**
 * `p` resolved through symlinks, or as written when it does not exist yet. The native
 * resolver also returns the on-disk case; the JS one keeps the caller's, so on a
 * case-insensitive filesystem `~/.CLAUDE/x` would slip past a check against `~/.claude`.
 */
function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `~` and `~/x` expand to the home directory; everything else is left alone. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

const GIT_PROBE_TIMEOUT_MS = 2000;

/** The top level of the git work tree holding `dir`, or null when there is none. The probe is bounded, so a hung mount cannot stall the gateway. */
function gitTopLevel(dir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    return out.trim() ? real(out.trim()) : null;
  } catch {
    return null;
  }
}

/** Neither the directory nor anything above it may be one of these roots. */
function exactOrAncestorRoots(options: WorkdirOptions): string[] {
  return [os.homedir(), resolveJinnHome(), departmentStageRoot(), path.join(os.homedir(), ".claude"), ...(options.claudeConfigDirs ?? [])].map(real);
}

/** Nothing inside any of these may be a department's working directory. */
function protectedTrees(options: WorkdirOptions): string[] {
  const home = os.homedir();
  return [
    resolveJinnHome(),
    departmentStageRoot(),
    ...[".claude", ".ssh", ".config", ".aws", ".gnupg", "Library"].map((name) => path.join(home, name)),
    ...(options.claudeConfigDirs ?? []),
  ].map(real);
}

/**
 * Why `entry` cannot be a working directory, or null when it can. The path is
 * realpath-normalised first, so a symlink cannot walk a check back in.
 */
export function workdirRefusal(entry: string, options: WorkdirOptions = {}): string | null {
  const expanded = expandHome(entry.trim());
  if (!path.isAbsolute(expanded)) return `${entry} is not an absolute path`;
  if (!fs.existsSync(expanded)) return `${entry} does not exist`;
  const dir = real(expanded);
  if (exactOrAncestorRoots(options).some((root) => isWithin(root, dir))) {
    return `${entry} is, or contains, the home directory or the gateway's own state`;
  }
  if (protectedTrees(options).some((tree) => isWithin(dir, tree))) {
    return `${entry} is inside a protected directory`;
  }
  const top = gitTopLevel(dir);
  if (!top) return `${entry} is not inside a git work tree`;
  if (isWithin(os.homedir(), top)) return `${entry} is inside a git work tree rooted at the home directory or above it`;
  return null;
}

/** The realpath a valid working directory is stored as. */
export function normalisedWorkdir(entry: string): string {
  return real(expandHome(entry.trim()));
}
