import { logger } from "./logger.js";
import type { Employee, Session } from "./types.js";

const DEFAULT_EFFORT = "high";

/** Known level names, lightest to heaviest; used to find the level nearest the default. */
const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Engines whose level is a setting on the CLI's own screen, not a flag: when
 * nothing chose one, naming a level would change the model's reasoning from
 * whatever it was set to, so they are told `default`, which they leave alone.
 */
const UNSET_EFFORT_ENGINES: ReadonlySet<string> = new Set(["freebuff"]);

/**
 * The built-in default for a model's level list: `high` when it has it, else the
 * nearest known level (the lighter one on a tie), else the first level. Never a
 * level the model does not list; with no levels at all the default is returned
 * as-is, since an engine without an effort concept ignores it.
 */
function builtInEffort(validLevels: string[]): string {
  if (validLevels.length === 0 || validLevels.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  const target = EFFORT_LADDER.indexOf(DEFAULT_EFFORT);
  let best: { level: string; distance: number; rank: number } | undefined;
  for (const level of validLevels) {
    const rank = EFFORT_LADDER.indexOf(level);
    if (rank < 0) continue;
    const distance = Math.abs(rank - target);
    if (!best || distance < best.distance || (distance === best.distance && rank < best.rank)) {
      best = { level, distance, rank };
    }
  }
  return best?.level ?? validLevels[0];
}

function unchosenEffort(engine: string | undefined, validLevels: string[]): string {
  return engine !== undefined && UNSET_EFFORT_ENGINES.has(engine) ? "default" : builtInEffort(validLevels);
}

/**
 * Resolve the effort level for a session.
 *
 * Valid effort levels come from the model registry (`validLevels`) for the
 * session's engine+model — NOT a hardcoded set — so e.g. codex's `xhigh`
 * validates and passes through instead of being silently dropped. Unknown or
 * unsupported levels are dropped with a logged warning (graceful degradation),
 * never a silent pass or a hard throw.
 *
 * For child sessions (has parentSessionId), resolution chain:
 *   1. config.engines.<engine>.childEffortOverride — global cost-control knob
 *   2. session.effortLevel — COO's per-task judgment (from API body)
 *   3. employee.effortLevel — employee YAML default
 *   4. config.engines.<engine>.effortLevel — engine fallback
 *
 * For non-child sessions, session.effortLevel wins when the user selected it in
 * the composer, then an assigned employee's default, then engine effortLevel.
 *
 * When nothing chooses a level the built-in default is `high`, or the nearest
 * level the model lists when it has no `high`. When the engine/model has no
 * effort concept (validLevels empty, e.g. Antigravity), returns the default
 * without warnings — effort is just ignored.
 */
export function resolveEffort(
  engineConfig: { effortLevel?: string; childEffortOverride?: string },
  session: Pick<Session, "parentSessionId" | "effortLevel">,
  employee: Pick<Employee, "effortLevel"> | null | undefined,
  validLevels: string[],
  engine?: string,
): string {
  if (validLevels.length === 0) return unchosenEffort(engine, validLevels);
  const isValid = (level: string) => validLevels.includes(level);
  const clean = (level: string | null | undefined) => level && level !== "default" ? level : undefined;

  if (session.parentSessionId) {
    const override = clean(engineConfig.childEffortOverride);
    if (override) {
      if (isValid(override)) return override;
      logger.warn(`Invalid childEffortOverride "${override}" (valid: ${validLevels.join(", ")}), skipping`);
    }

    const requested = clean(session.effortLevel);
    if (requested) {
      if (isValid(requested)) return requested;
      logger.warn(`Invalid effortLevel "${requested}" on session (valid: ${validLevels.join(", ")}), skipping`);
    }

    const empDefault = clean(employee?.effortLevel);
    if (empDefault) {
      if (isValid(empDefault)) return empDefault;
      logger.warn(`Invalid effortLevel "${empDefault}" on employee (valid: ${validLevels.join(", ")}), skipping`);
    }
  } else {
    const requested = clean(session.effortLevel);
    if (requested) {
      if (isValid(requested)) return requested;
      logger.warn(`Invalid effortLevel "${requested}" on session (valid: ${validLevels.join(", ")}), skipping`);
    }

    const empDefault = clean(employee?.effortLevel);
    if (empDefault) {
      if (isValid(empDefault)) return empDefault;
      logger.warn(`Invalid effortLevel "${empDefault}" on employee (valid: ${validLevels.join(", ")}), skipping`);
    }
  }

  // Non-child sessions (COO) or fallback
  const engineDefault = clean(engineConfig.effortLevel);
  if (engineDefault && isValid(engineDefault)) return engineDefault;
  if (engineDefault) logger.warn(`Invalid effortLevel "${engineDefault}" in engine config (valid: ${validLevels.join(", ")}), defaulting to "${unchosenEffort(engine, validLevels)}"`);
  return unchosenEffort(engine, validLevels);
}
