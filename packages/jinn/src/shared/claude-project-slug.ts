/** The project key Claude Code files a cwd's transcripts under: the cwd with every
 *  non-alphanumeric character replaced by "-" (so `~/.jinn` is `…--jinn`). The cwd is
 *  the Jinn home, or a scoped session's stage directory (FR-020), and the forks and
 *  the transcript readers must agree on it. A pure function with no imports, so a
 *  process can compute it before it has settled which home it belongs to. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
