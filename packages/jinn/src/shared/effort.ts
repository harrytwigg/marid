import { logger } from "./logger.js";
import type { Employee, JinnConfig, Session } from "./types.js";
import { DETAILS_TIMEOUT_MS } from "./opencode-discovery.js";
import { effortLevelsPending, effortLevelsSettled } from "./opencode-catalogue.js";

const DEFAULT_EFFORT = "medium";

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
 * When the engine/model has no effort concept (validLevels empty, e.g.
 * Antigravity), returns the default without warnings — effort is just ignored.
 */
export function resolveEffort(
  engineConfig: { effortLevel?: string; childEffortOverride?: string },
  session: Pick<Session, "parentSessionId" | "effortLevel">,
  employee: Pick<Employee, "effortLevel"> | null | undefined,
  validLevels: string[],
): string {
  if (validLevels.length === 0) return DEFAULT_EFFORT;
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
  if (engineDefault) {
    logger.warn(`Invalid effortLevel "${engineDefault}" in engine config (valid: ${validLevels.join(", ")}), defaulting to "${DEFAULT_EFFORT}"`);
  }
  return DEFAULT_EFFORT;
}

type EffortSources = Parameters<typeof resolveEffort>;

/** Whether {@link resolveEffort} has a level to look at beyond the default. */
function hasEffortChoice(engineConfig: EffortSources[0], session: EffortSources[1], employee: EffortSources[2]): boolean {
  const set = (level: string | null | undefined) => Boolean(level && level !== "default");
  return (Boolean(session.parentSessionId) && set(engineConfig.childEffortOverride))
    || set(session.effortLevel) || set(employee?.effortLevel) || set(engineConfig.effortLevel);
}

/**
 * Wait, bounded, for `engine`'s effort levels when discovery has not produced
 * them yet and the session has an effort to resolve: resolved sooner, that
 * effort would be dropped for want of the levels (`opencode-catalogue.ts`).
 */
export async function awaitEffortLevels(
  config: JinnConfig,
  engine: string,
  session: EffortSources[1],
  employee: EffortSources[2],
): Promise<void> {
  const engineConfig = (config.engines as unknown as Record<string, EffortSources[0] | undefined>)[engine] ?? {};
  if (!effortLevelsPending(engine) || !hasEffortChoice(engineConfig, session, employee)) return;
  logger.info(`Waiting for ${engine} model discovery before resolving an effort level`);
  await effortLevelsSettled(engine, DETAILS_TIMEOUT_MS);
}
