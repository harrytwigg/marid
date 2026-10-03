import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { CronJob } from "../shared/types.js";
import { ENGINE_NAMES, isKnownEngine } from "../shared/models.js";
import { JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js";

/**
 * The board walk's rules file: `$JINN_HOME/board-walk.md`.
 *
 * The YAML frontmatter holds the mechanical settings — as whom the walk runs,
 * on which model, and a hard switch per action. The Markdown body is the
 * operator's prose: what counts as a gate, what the walk may do, and when and
 * what to dispatch. The gateway reads the frontmatter; only the model reads the
 * body.
 *
 * When the walk runs is not here: it is the `board-walk` cron job (job.ts), so
 * it is listed, run, rescheduled and switched off like any other job. The
 * frontmatter keys that used to hold it (`enabled`, `schedule`, `timezone`) are
 * moved into that job once, on upgrade, and are not read after that.
 *
 * The switches exist so that "off" never depends on a model following prose.
 * `actions.dispatch: false` means the gateway refuses every start the walk asks
 * for, whatever the body says; the body can only narrow what a switch allows.
 *
 * The file is re-read on every tick, so an edit takes effect without a restart. A file that cannot be read or parsed is reported as a
 * problem and the walk does nothing: a broken rules file is never a reason to act.
 */

export const BOARD_WALK_FILE = "board-walk.md";

export function boardWalkPath(home: string = JINN_HOME): string {
  return path.join(home, BOARD_WALK_FILE);
}

export const BOARD_WALK_ACTIONS = ["release", "park", "flagStuck", "dispatch", "comment"] as const;
export type BoardWalkAction = (typeof BOARD_WALK_ACTIONS)[number];

export interface BoardWalkSettings {
  /** The employee whose engine runs the walk's turn. */
  employee: string;
  /** The engine the walk's turn runs on. Only the engines that can be confined
   *  to the walk's own tools may be named (walk.ts route-turn.ts). */
  engine: string;
  /** Model for the walk's turn; undefined means the employee's own, or the
   *  engine's default. */
  model?: string;
  /** Effort level for the walk's turn; undefined means the employee's own. */
  effortLevel?: string;
  actions: Record<BoardWalkAction, boolean>;
}

export interface BoardWalkRules {
  settings: BoardWalkSettings;
  /** The Markdown body, frontmatter removed. */
  body: string;
  /** Why the file could not be used as written. Non-empty means the walk holds. */
  problems: string[];
  /** False when there is no file at all. */
  exists: boolean;
  /** Retired schedule keys still in the frontmatter. They are not read. */
  retiredKeys: string[];
}

/** The frontmatter keys the cron job took over. */
export const RETIRED_SCHEDULE_KEYS = ["enabled", "schedule", "timezone"] as const;

export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const BOARD_WALK_DEFAULTS: BoardWalkSettings = {
  employee: "assistant",
  engine: "claude",
  model: "sonnet",
  actions: { release: true, park: true, flagStuck: true, dispatch: true, comment: true },
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Where the frontmatter's own text sits in `text` (between the fences), or
 *  null when the file has none. */
export function frontmatterSpan(text: string): { start: number; end: number } | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const start = text.startsWith("---\r\n") ? 5 : 4;
  return { start, end: start + match[1].length };
}

export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringSetting(raw: Record<string, unknown>, key: string, problems: string[]): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    problems.push(`${key} must be a string (got ${typeof value})`);
    return undefined;
  }
  return value.trim();
}

function actionSettings(raw: unknown, problems: string[]): Record<BoardWalkAction, boolean> {
  const actions = { ...BOARD_WALK_DEFAULTS.actions };
  if (raw === undefined || raw === null) return actions;
  if (!isMapping(raw)) {
    problems.push("actions must be a mapping of " + BOARD_WALK_ACTIONS.join(", "));
    return actions;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(BOARD_WALK_ACTIONS as readonly string[]).includes(key)) {
      problems.push(`actions.${key} is not an action (actions are ${BOARD_WALK_ACTIONS.join(", ")})`);
      continue;
    }
    if (typeof value !== "boolean") {
      problems.push(`actions.${key} must be true or false`);
      continue;
    }
    actions[key as BoardWalkAction] = value;
  }
  return actions;
}

/** The engine for the turn: the named one, or the default. A named engine this
 *  build does not know is a problem, not a silent fallback. */
function engineSetting(mapping: Record<string, unknown>, problems: string[]): string {
  const engine = stringSetting(mapping, "engine", problems) || BOARD_WALK_DEFAULTS.engine;
  if (Object.prototype.hasOwnProperty.call(mapping, "engine") && !isKnownEngine(engine)) {
    problems.push(`engine ${JSON.stringify(mapping.engine)} is not one of ${ENGINE_NAMES.join(", ")}`);
  }
  return engine;
}

/**
 * An explicit empty model means "the engine's own"; absent means the default
 * model, but only for the default engine. A named engine with no model named
 * gets its own default rather than the shipped Claude model, which would not
 * belong to it.
 */
function modelSetting(mapping: Record<string, unknown>, engine: string, problems: string[]): string | undefined {
  if (Object.prototype.hasOwnProperty.call(mapping, "model")) return stringSetting(mapping, "model", problems) || undefined;
  return engine === BOARD_WALK_DEFAULTS.engine ? BOARD_WALK_DEFAULTS.model : undefined;
}

/** Resolve a parsed frontmatter mapping onto the defaults, collecting problems. */
export function resolveSettings(raw: unknown): { settings: BoardWalkSettings; problems: string[]; retiredKeys: string[] } {
  const problems: string[] = [];
  const mapping = raw ?? {};
  if (!isMapping(mapping)) {
    return { settings: { ...BOARD_WALK_DEFAULTS }, problems: ["the frontmatter must be a YAML mapping"], retiredKeys: [] };
  }
  const employee = stringSetting(mapping, "employee", problems) || BOARD_WALK_DEFAULTS.employee;
  const engine = engineSetting(mapping, problems);
  const model = modelSetting(mapping, engine, problems);
  const effortLevel = stringSetting(mapping, "effortLevel", problems) || undefined;
  const actions = actionSettings(mapping.actions, problems);
  // Not a problem: a retired key changes nothing, so it is no reason to hold.
  const retiredKeys = RETIRED_SCHEDULE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(mapping, key));
  return { settings: { employee, engine, ...(model ? { model } : {}), ...(effortLevel ? { effortLevel } : {}), actions }, problems, retiredKeys };
}

/**
 * The runner settings in force: the rules file's, with the `board-walk` cron
 * job's own `employee`, `engine`, `model` and `effortLevel` overriding them
 * when it sets them. One source of truth per value, with the job (the object
 * the cron controls edit) beating the file. Absent on both, the shipped
 * defaults stand, so an install that named neither behaves exactly as before.
 */
export function withRunnerOverrides(
  settings: BoardWalkSettings,
  job: Pick<CronJob, "employee" | "engine" | "model" | "effortLevel"> | undefined,
): BoardWalkSettings {
  if (!job) return settings;
  const override: Partial<BoardWalkSettings> = {};
  if (job.employee?.trim()) override.employee = job.employee.trim();
  if (job.engine?.trim()) override.engine = job.engine.trim();
  if (job.model?.trim()) override.model = job.model.trim();
  if (job.effortLevel?.trim()) override.effortLevel = job.effortLevel.trim();
  return { ...settings, ...override };
}

/** The parsed frontmatter mapping, or undefined when there is none or it is not
 *  a YAML mapping. */
export function frontmatterMapping(text: string): Record<string, unknown> | undefined {
  const { frontmatter } = splitFrontmatter(text);
  if (frontmatter === null) return undefined;
  try {
    const raw = yaml.load(frontmatter);
    return isMapping(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function parseRules(text: string): Omit<BoardWalkRules, "exists"> {
  const { frontmatter, body } = splitFrontmatter(text);
  let raw: unknown = {};
  const problems: string[] = [];
  if (frontmatter !== null) {
    try {
      raw = yaml.load(frontmatter);
    } catch (error) {
      problems.push(`the frontmatter is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      raw = {};
    }
  }
  const resolved = resolveSettings(raw);
  return { settings: resolved.settings, body: body.trim(), problems: [...problems, ...resolved.problems], retiredKeys: resolved.retiredKeys };
}

export function readRules(file: string = boardWalkPath()): BoardWalkRules {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      settings: { ...BOARD_WALK_DEFAULTS },
      body: "",
      problems: [missing ? `${BOARD_WALK_FILE} does not exist` : `${BOARD_WALK_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`],
      exists: false,
      retiredKeys: [],
    };
  }
  return { ...parseRules(text), exists: true };
}

// ── Shipped defaults for missing sections ───────────────────────────────────

export const TEMPLATE_RULES_FILE = path.join(TEMPLATE_DIR, BOARD_WALK_FILE);

/** The `## ` sections of a rules body, keyed by lowercased heading. */
export function rulesSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^(?=## )/m);
  for (const part of parts) {
    const heading = /^## (.+)$/m.exec(part)?.[1]?.trim();
    if (heading && part.startsWith("## ")) sections.set(heading.toLowerCase(), part.trim());
  }
  return sections;
}

/**
 * The shipped sections the operator's rules leave out. The file promises that
 * a deleted section falls back to the shipped default, so those sections go to
 * the model beside the operator's own, marked as defaults. "Your own rules" has
 * no default content and is never added.
 */
export function missingDefaultSections(body: string, template: string): string[] {
  const present = rulesSections(body);
  const shipped = rulesSections(splitFrontmatter(template).body);
  return [...shipped].filter(([heading]) => heading !== "your own rules" && !present.has(heading)).map(([, text]) => text);
}

export function readTemplateRules(file: string = TEMPLATE_RULES_FILE): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}
