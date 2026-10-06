import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDirFor, type ClaudeProfile } from "../shared/claude-profile.js";
import { resolveClaudeConfigDir } from "../shared/home.js";
import { JINN_HOME } from "../shared/paths.js";

/** Claude Code stores per-project transcripts at
 *  ~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl, where the slug is the
 *  cwd with every "/" and "." replaced by "-". Derive that path; fall back to a
 *  scan across project dirs if the slug heuristic misses (defensive). Exported
 *  for the transcript-recovery unit test. */
export function findTranscriptForSession(
  claudeSessionId: string,
  homeDir: string = JINN_HOME,
  projectsDir: string = path.join(resolveClaudeConfigDir(), "projects"),
): string | undefined {
  if (!claudeSessionId) return undefined;
  const slug = homeDir.replace(/[/.]/g, "-");
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

/** The transcript of a Claude session that ran on `profile`. Claude Code writes
 *  it under the profile's own config dir, so a session on another profile is
 *  not under the gateway's `~/.claude/projects`; undefined means the gateway's
 *  own profile. */
export function findSessionTranscript(claudeSessionId: string, profile: ClaudeProfile | undefined): string | undefined {
  return findTranscriptForSession(claudeSessionId, JINN_HOME, claudeProjectsDirFor(profile ?? null));
}
