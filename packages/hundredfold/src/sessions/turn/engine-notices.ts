import { logger } from "../../shared/logger.js";
import type { TurnSurface } from "./types.js";

/**
 * The notices an engine asked for (`EngineResult.notices`), once each, ahead of the
 * reply. A courtesy: a surface that cannot take one must not fail a turn whose engine
 * run succeeded. Called wherever a turn's engine result is taken: the attempt itself,
 * a chain hop's substitute and a parked retry.
 */
export async function postEngineNotices(surface: TurnSurface, sessionId: string, notices: string[] | undefined): Promise<void> {
  for (const notice of notices ?? []) {
    try {
      await surface.notice(notice);
    } catch (err) {
      logger.warn(`Session ${sessionId}: could not post an engine notice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
