import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { JINN_HOME } from "../shared/paths.js";
import { validateCronSchedule } from "../cron/validation.js";

/**
 * The board walk's rules file: `$JINN_HOME/board-walk.md`.
 *
 * The YAML frontmatter holds the mechanical settings — whether the walk runs,
 * when, as whom, on which model, and a hard switch per action. The Markdown body
 * is the operator's prose: what counts as a gate, what the walk may do, and when
 * and what to dispatch. The gateway reads the frontmatter; only the model reads
 * the body.
 *
 * The switches exist so that "off" never depends on a model following prose.
 * `actions.dispatch: false` means the gateway refuses every start the walk asks
 * for, whatever the body says; the body can only narrow what a switch allows.
 *
 * The file is re-read on every tick and by the scheduler's poll, so an edit takes
 * effect without a restart. A file that cannot be read or parsed is reported as a
 * problem and the walk does nothing: a broken rules file is never a reason to act.
 */

export const BOARD_WALK_FILE = "board-walk.md";

export function boardWalkPath(home: string = JINN_HOME): string {
  return path.join(home, BOARD_WALK_FILE);
}

export const BOARD_WALK_ACTIONS = ["release", "park", "flagStuck", "dispatch", "comment"] as const;
export type BoardWalkAction = (typeof BOARD_WALK_ACTIONS)[number];

export interface BoardWalkSettings {
  enabled: boolean;
  /** Five-field cron expression. */
  schedule: string;
  /** IANA zone the schedule and the walk's "local time" are read in. */
  timezone: string;
  /** The employee whose engine runs the walk's turn. */
  employee: string;
  /** Model for the walk's turn; undefined means the employee's own. */
  model?: string;
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
}

export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const BOARD_WALK_DEFAULTS: BoardWalkSettings = {
  enabled: true,
  schedule: "0 * * * *",
  timezone: "",
  employee: "assistant",
  model: "sonnet",
  actions: { release: true, park: true, flagStuck: true, dispatch: true, comment: true },
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

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

/** Resolve a parsed frontmatter mapping onto the defaults, collecting problems. */
export function resolveSettings(raw: unknown): { settings: BoardWalkSettings; problems: string[] } {
  const problems: string[] = [];
  const mapping = raw === undefined || raw === null ? {} : raw;
  if (!isMapping(mapping)) {
    return { settings: { ...BOARD_WALK_DEFAULTS, timezone: hostTimezone() }, problems: ["the frontmatter must be a YAML mapping"] };
  }
  let enabled = BOARD_WALK_DEFAULTS.enabled;
  if (mapping.enabled !== undefined) {
    if (typeof mapping.enabled === "boolean") enabled = mapping.enabled;
    else problems.push("enabled must be true or false");
  }
  const schedule = stringSetting(mapping, "schedule", problems) || BOARD_WALK_DEFAULTS.schedule;
  const timezone = stringSetting(mapping, "timezone", problems) || hostTimezone();
  for (const error of validateCronSchedule({ schedule, timezone })) problems.push(`${error.field}: ${error.message}`);
  const employee = stringSetting(mapping, "employee", problems) || BOARD_WALK_DEFAULTS.employee;
  // An explicit empty model means "the employee's own"; absent means the default.
  const model = mapping.model === undefined ? BOARD_WALK_DEFAULTS.model : stringSetting(mapping, "model", problems) || undefined;
  const actions = actionSettings(mapping.actions, problems);
  return { settings: { enabled, schedule, timezone, employee, ...(model ? { model } : {}), actions }, problems };
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
  return { settings: resolved.settings, body: body.trim(), problems: [...problems, ...resolved.problems] };
}

export function readRules(file: string = boardWalkPath()): BoardWalkRules {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      settings: { ...BOARD_WALK_DEFAULTS, timezone: hostTimezone() },
      body: "",
      problems: [missing ? `${BOARD_WALK_FILE} does not exist` : `${BOARD_WALK_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`],
      exists: false,
    };
  }
  return { ...parseRules(text), exists: true };
}
