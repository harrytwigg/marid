import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDirFor, type ClaudeProfile } from "../shared/claude-profile.js";
import { resolveClaudeConfigDir } from "../shared/home.js";
import { JINN_HOME } from "../shared/paths.js";

/** The project key Claude Code files a cwd's transcripts under: the cwd with every
 *  non-alphanumeric character replaced by "-" (so `~/.jinn` is `…--jinn`). The cwd is
 *  the Jinn home, or a scoped session's stage directory (FR-020), and the forks and
 *  the transcript readers must agree on it. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Claude Code stores per-project transcripts at
 *  ~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl. Derive that path from the
 *  session's cwd; fall back to a scan across project dirs if the slug misses
 *  (defensive). Exported for the transcript-recovery unit test. */
export function findTranscriptForSession(
  claudeSessionId: string,
  homeDir: string = JINN_HOME,
  projectsDir: string = path.join(resolveClaudeConfigDir(), "projects"),
): string | undefined {
  if (!claudeSessionId) return undefined;
  const slug = claudeProjectSlug(homeDir);
  const direct = path.join(projectsDir, slug, `${claudeSessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* projects dir missing — nothing to recover */ }
  return undefined;
}

/** The transcript of a Claude session that ran on `profile` in `cwd`. Claude Code
 *  writes it under the profile's own config dir, so a session on another profile is
 *  not under the gateway's `~/.claude/projects`; undefined means the gateway's
 *  own profile. `cwd` is where the session ran: the Jinn home unless it is scoped. */
export function findSessionTranscript(claudeSessionId: string, profile: ClaudeProfile | undefined, cwd: string = JINN_HOME): string | undefined {
  return findTranscriptForSession(claudeSessionId, cwd, claudeProjectsDirFor(profile ?? null));
}
