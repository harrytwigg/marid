import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_PATH, JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js";
import { saveConfigAtomic } from "../shared/config.js";
import { BOARD_WALK_FILE, boardWalkPath } from "./settings.js";
import { convertLegacyBlock } from "./legacy-idle-capacity.js";

/**
 * Seed `$JINN_HOME/board-walk.md` from the template, and retire the old
 * `gateway.idleCapacity` block. Runs on `jinn setup` and on every gateway boot,
 * so a fresh install and an upgrade both end with exactly one source of dispatch
 * rules and no idle-capacity config.
 *
 *   - The file is written only when it is missing. An operator's edits are never
 *     overwritten, by an upgrade or by anything else.
 *   - A `gateway.idleCapacity` block is converted into equivalent prose in the
 *     file's Dispatch section — but only when the file is being created. When the
 *     file already exists the operator owns its wording, so the block is not
 *     merged in; the upgrade log says so.
 *   - Either way the block is removed from config.yaml, after a copy of the file
 *     as it was is kept beside it.
 *
 * Never throws: a seeding failure is reported to the caller to log, and the
 * gateway still starts (the walk then holds, reporting the missing file).
 */

export interface SeedResult {
  /** The rules file was created by this call. */
  seeded: boolean;
  /** It was created from a legacy block rather than the stock template. */
  converted: boolean;
  /** What the conversion carried into the frontmatter. */
  notes: string[];
  /** A `gateway.idleCapacity` block was removed from config.yaml. */
  removedBlock: boolean;
  /** The block was removed but NOT merged, because the file already existed. */
  blockDiscarded: boolean;
  /** Where the pre-removal config.yaml was copied. */
  backupPath?: string;
  error?: string;
}

export interface SeedOptions {
  home?: string;
  templateDir?: string;
  configPath?: string;
  now?: () => Date;
}

function readConfigDocument(configPath: string): Record<string, unknown> | undefined {
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function legacyBlock(doc: Record<string, unknown> | undefined): { present: boolean; value: unknown } {
  const gateway = doc?.gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) return { present: false, value: undefined };
  return Object.prototype.hasOwnProperty.call(gateway, "idleCapacity")
    ? { present: true, value: (gateway as Record<string, unknown>).idleCapacity }
    : { present: false, value: undefined };
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function removeBlock(configPath: string, doc: Record<string, unknown>, now: Date): string {
  const backupPath = `${configPath}.pre-board-walk-${stamp(now)}`;
  fs.copyFileSync(configPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  const gateway = { ...(doc.gateway as Record<string, unknown>) };
  delete gateway.idleCapacity;
  const next = { ...doc, gateway };
  if (path.resolve(configPath) === path.resolve(CONFIG_PATH)) {
    saveConfigAtomic(next);
  } else {
    const tmp = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, yaml.dump(next), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, configPath);
  }
  return backupPath;
}

export function seedBoardWalk(opts: SeedOptions = {}): SeedResult {
  const home = opts.home ?? JINN_HOME;
  const templateDir = opts.templateDir ?? TEMPLATE_DIR;
  const configPath = opts.configPath ?? path.join(home, "config.yaml");
  const now = (opts.now ?? (() => new Date()))();
  const result: SeedResult = { seeded: false, converted: false, notes: [], removedBlock: false, blockDiscarded: false };
  try {
    const file = boardWalkPath(home);
    const exists = fs.existsSync(file);
    const doc = fs.existsSync(configPath) ? readConfigDocument(configPath) : undefined;
    const legacy = legacyBlock(doc);

    if (!exists) {
      const template = fs.readFileSync(path.join(templateDir, BOARD_WALK_FILE), "utf-8");
      const converted = legacy.present ? convertLegacyBlock(template, legacy.value) : undefined;
      fs.writeFileSync(file, converted?.text ?? template, { encoding: "utf-8", flag: "wx" });
      result.seeded = true;
      result.converted = converted !== undefined;
      result.notes = converted?.notes ?? [];
    }

    if (legacy.present && doc) {
      result.backupPath = removeBlock(configPath, doc, now);
      result.removedBlock = true;
      result.blockDiscarded = exists;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** One line for the boot log, or undefined when nothing happened. */
export function describeSeed(result: SeedResult): string | undefined {
  if (result.error) return `Board walk: could not seed ${BOARD_WALK_FILE}: ${result.error}`;
  const parts: string[] = [];
  if (result.seeded) {
    parts.push(result.converted
      ? `created ${BOARD_WALK_FILE} from gateway.idleCapacity (${result.notes.join("; ")})`
      : `created ${BOARD_WALK_FILE} from the template`);
  }
  if (result.removedBlock) {
    parts.push(result.blockDiscarded
      ? `removed gateway.idleCapacity from config.yaml WITHOUT merging it, because ${BOARD_WALK_FILE} already exists — copy any settings you still want into its Dispatch section (old file: ${result.backupPath})`
      : `removed gateway.idleCapacity from config.yaml (old file: ${result.backupPath})`);
  }
  return parts.length > 0 ? `Board walk: ${parts.join("; ")}` : undefined;
}
