import { logger } from "./logger.js";
import type { JinnConfig } from "./types.js";
import type { resolveEffort } from "./effort.js";
import { DETAILS_TIMEOUT_MS } from "./opencode-discovery.js";
import { effortLevelsPending, effortLevelsSettled } from "./opencode-catalogue.js";

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
  session: EffortSources[1] & { model?: string | null },
  employee: EffortSources[2],
): Promise<void> {
  const engineConfig = (config.engines as unknown as Record<string, (EffortSources[0] & { model?: string }) | undefined>)[engine] ?? {};
  const model = session.model ?? engineConfig.model;
  if (!effortLevelsPending(engine, model) || !hasEffortChoice(engineConfig, session, employee)) return;
  logger.info(`Waiting for ${engine} model discovery before resolving an effort level`);
  await effortLevelsSettled(engine, DETAILS_TIMEOUT_MS, model);
}
