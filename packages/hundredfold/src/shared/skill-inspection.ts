import fs from "node:fs";
import path from "node:path";

/**
 * What makes a skill copyable into a department's stage directory (FR-020, FR-020a), and
 * the copy. The stage generator reads a skill with `readSkill`; the department panel and
 * the Todo skill validation ask `skillRefusal` whether it would, so the three cannot
 * disagree about which skills a scoped department can be given.
 *
 * A skill is a playbook, not a repository: it is refused when it holds a symlink (the link
 * would reach a path the stage directory is there to keep out, and would be copied to a
 * remote host), a file that is not a regular file, more files or bytes than a copy before
 * every spawn can afford, or no `SKILL.md`.
 */

export interface SkillFile {
  content: Buffer;
  /** Whether the owner-execute bit is set. Nothing else about a mode is kept. */
  executable: boolean;
}

const SKILL_MAX_FILES = 2000;
const SKILL_MAX_BYTES = 20_000_000;
const IGNORED_NAMES = new Set([".DS_Store"]);
const NO_CONTENT = Buffer.alloc(0);

export class SkillRefused extends Error {}

/**
 * Every file of one skill, as `relative path -> file`. Throws `SkillRefused` for a link, a
 * special file, an oversize skill or one with no `SKILL.md`. With `contents` false the files
 * are judged but not read, and each comes back empty.
 */
export function readSkill(root: string, contents = true): Map<string, SkillFile> {
  const out = new Map<string, SkillFile>();
  let bytes = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new SkillRefused(`it contains a symlink (${relative})`);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        bytes += stat.size;
        if (out.size >= SKILL_MAX_FILES || bytes > SKILL_MAX_BYTES) throw new SkillRefused(`it is over ${SKILL_MAX_FILES} files or ${SKILL_MAX_BYTES} bytes`);
        out.set(relative, { content: contents ? fs.readFileSync(absolute) : NO_CONTENT, executable: (stat.mode & 0o100) !== 0 });
      } else {
        throw new SkillRefused(`it contains a file that is not a regular file (${relative})`);
      }
    }
  };
  if (!fs.lstatSync(root).isDirectory()) throw new SkillRefused("it is not a directory");
  walk(root, "");
  if (!out.has("SKILL.md")) throw new SkillRefused("it has no SKILL.md");
  return out;
}

/** Why the skill at `root` cannot be copied to a stage directory, or null when it can. */
export function skillRefusal(root: string): string | null {
  try {
    readSkill(root, false);
    return null;
  } catch (err) {
    return err instanceof SkillRefused ? err.message : `it could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}
