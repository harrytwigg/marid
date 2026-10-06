import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { compareSemver } from "./version.js";

/**
 * Whether a Claude Code install honours the `claudeMdExcludes` setting, which a
 * department-scoped session relies on to skip the instructions in the directories above
 * its stage directory (Claude Code reads them from every ancestor of its cwd). An older
 * build ignores the key silently, so a scoped session is refused on one rather than
 * started with whatever an ancestor holds.
 *
 * Judged by what `claude --version` reports, so a shim or wrapper script (mise, asdf,
 * volta, nix) answers for the build it runs, and nothing reads the binary itself.
 */

/** The oldest Claude Code verified to carry the setting. An older build may too, but is refused rather than assumed to. */
export const CLAUDE_MD_EXCLUDES_MIN_VERSION = "2.1.288";

/** The version in a `claude --version` line, such as "2.1.291 (Claude Code)". */
function parseVersion(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null;
}

/**
 * Why the Claude Code at `where`, which printed `versionOutput` for `--version`, cannot run
 * a scoped session; null when it can. An empty output stands for a run that failed.
 */
export function claudeMdExcludesProblem(where: string, versionOutput: string): string | null {
  const version = parseVersion(versionOutput);
  if (version && compareSemver(version, CLAUDE_MD_EXCLUDES_MIN_VERSION) >= 0) return null;
  const reported = version ? `reports ${version}` : "did not report a version for `--version`";
  return `the Claude Code at ${where} ${reported}; a department-scoped session needs ${CLAUDE_MD_EXCLUDES_MIN_VERSION} or later, which can be told to skip the CLAUDE.md files above its stage directory (claudeMdExcludes)`;
}

/** Binaries that passed. Only a pass is kept: a refusal is asked again, so an upgrade made
 *  through a version manager whose shim never changes, or a run that merely timed out, is
 *  not held against the next turn. A downgrade at the same path keeps passing until the
 *  binary itself changes; that is accepted for a guardrail. */
const passed = new Set<string>();

/** The local check: run `bin --version`, remembering a pass per path, size and modification time. */
export function localClaudeMdExcludesProblem(bin: string): string | null {
  let key = bin;
  try {
    const real = fs.realpathSync(bin);
    const stat = fs.statSync(real);
    key = `${real}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    // Not a path we can see (a bare name, say): asked every time, never cached.
  }
  if (passed.has(key)) return null;
  let output = "";
  try {
    output = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    output = "";
  }
  const problem = claudeMdExcludesProblem(bin, output);
  if (!problem && key !== bin) passed.add(key);
  return problem;
}

type Probe = (bin: string) => string | null;
let probe: Probe | null = null;

/**
 * The check a scoped local turn runs, registered at gateway boot ({@link localClaudeMdExcludesProblem}).
 * With none registered, as in a test, every binary passes, so no suite depends on which
 * Claude Code the machine running it has installed.
 */
export function setClaudeMdExcludesProbe(next: Probe | null): void {
  probe = next;
}

/** Why a scoped local session may not start with `bin`; null when it may. */
export function scopedClaudeProblem(bin: string): string | null {
  return probe ? probe(bin) : null;
}

export function clearClaudeMdExcludesCacheForTests(): void {
  passed.clear();
}
