import fs from "node:fs";
import path from "node:path";
import { logger } from "../../shared/logger.js";
import type { InstructionsMode } from "../department-definition.js";
import { departmentScopeParagraph } from "./scope-paragraph.js";

/**
 * The content of a department's stage directory (FR-020, FR-029), as data. The generator
 * reads the instance and returns the files; it writes nothing, so the local sync and the
 * remote hosts' sync apply exactly the same content.
 *
 * ```
 * CLAUDE.md             INSTRUCTIONS.md, then the company CLAUDE.md when asked for, then the scope paragraph
 * .claude/skills/<s>/   a copy of skills/<s> for each allow-listed skill
 * ```
 */

export interface StageFile {
  content: Buffer;
  /** Whether the owner-execute bit is set. Nothing else about a mode is kept. */
  executable: boolean;
}

/** Files only, keyed by a POSIX path relative to the stage directory. Directories follow from the keys. */
export type StageFileSet = ReadonlyMap<string, StageFile>;

export interface StageFileSetResult {
  files: StageFileSet;
  /** Allow-listed skills left out, and why. */
  refused: Array<{ skill: string; reason: string }>;
}

export interface StageInputs {
  /** `$JINN_HOME`. */
  home: string;
  slug: string;
  /** What the department's last good file says; null when it has none. */
  definition: { skills: readonly string[]; instructions: InstructionsMode } | null;
}

export const STAGE_SKILLS_DIR = ".claude/skills";
export const STAGE_CLAUDE_MD = "CLAUDE.md";
/** A skill is a playbook, not a repository: past these it is refused rather than copied before every spawn. */
const SKILL_MAX_FILES = 2000;
const SKILL_MAX_BYTES = 20_000_000;
const INSTRUCTIONS_MAX_BYTES = 256_000;
const IGNORED_NAMES = new Set([".DS_Store"]);

/** The text of a regular file, or null when it is missing, a link, or too large. */
function readTextFile(file: string, label: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) {
      logger.warn(`${label} is not a regular file and is left out of the stage directory: ${file}`);
      return null;
    }
    if (stat.size > INSTRUCTIONS_MAX_BYTES) {
      logger.warn(`${label} is over ${INSTRUCTIONS_MAX_BYTES} bytes and is left out of the stage directory: ${file}`);
      return null;
    }
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** The department's `CLAUDE.md`: its instructions, the company file when it asks for it, then the fixed paragraph. */
function claudeMd(input: StageInputs): string {
  const parts: string[] = [];
  const own = readTextFile(path.join(input.home, "knowledge", "departments", input.slug, "INSTRUCTIONS.md"), "INSTRUCTIONS.md");
  if (own?.trim()) parts.push(own.trim());
  if (input.definition?.instructions === "department+company") {
    const company = readTextFile(path.join(input.home, "CLAUDE.md"), "The company CLAUDE.md");
    if (company?.trim()) parts.push(company.trim());
  }
  parts.push(departmentScopeParagraph(input.slug));
  return `${parts.join("\n\n")}\n`;
}

class SkillRefused extends Error {}

/** Every file of one skill, as `relative path -> file`. Throws SkillRefused for a link, a special file or an oversize skill. */
function readSkill(root: string): Map<string, StageFile> {
  const out = new Map<string, StageFile>();
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
        out.set(relative, { content: fs.readFileSync(absolute), executable: (stat.mode & 0o100) !== 0 });
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

export function generateStageFileSet(input: StageInputs): StageFileSetResult {
  const files = new Map<string, StageFile>();
  const refused: StageFileSetResult["refused"] = [];
  files.set(STAGE_CLAUDE_MD, { content: Buffer.from(claudeMd(input), "utf-8"), executable: false });
  for (const skill of input.definition?.skills ?? []) {
    try {
      for (const [relative, file] of readSkill(path.join(input.home, "skills", skill))) files.set(`${STAGE_SKILLS_DIR}/${skill}/${relative}`, file);
    } catch (err) {
      const reason = err instanceof SkillRefused ? err.message : `it could not be read: ${err instanceof Error ? err.message : String(err)}`;
      refused.push({ skill, reason });
      logger.warn(`Skill "${skill}" is left out of the "${input.slug}" stage directory: ${reason}`);
    }
  }
  return { files, refused };
}
