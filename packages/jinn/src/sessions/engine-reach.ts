import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";

/**
 * Whether any turn of a session ever reached its engine, kept in
 * `transportMeta.engineReach`: `"never"` once a turn was refused before an
 * engine ran and none has reached one, `"reached"` from the first turn that
 * got past the gates. A session from before the key existed has neither, and
 * reads as having reached its engine: the safe default for every reader,
 * since only `"never"` proves the session did no work.
 */
export const ENGINE_REACH_META_KEY = "engineReach";

/** A turn passed its gates and is about to run its engine. */
export function recordEngineReached(sessionId: string): void {
  initDb().prepare(`
    UPDATE sessions
    SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${ENGINE_REACH_META_KEY}', 'reached')
    WHERE id = ? AND COALESCE(json_extract(transport_meta, '$.${ENGINE_REACH_META_KEY}'), '') <> 'reached'
  `).run(sessionId);
}

/**
 * A turn was refused before its engine ran. Never marks a session that already
 * reached one, nor one with a recorded turn: that covers a session from before
 * the key existed, and a "reached" lost to a stale meta write.
 */
export function recordRefusedBeforeEngine(sessionId: string): void {
  initDb().prepare(`
    UPDATE sessions
    SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${ENGINE_REACH_META_KEY}', 'never')
    WHERE id = ? AND total_turns = 0
      AND COALESCE(json_extract(transport_meta, '$.${ENGINE_REACH_META_KEY}'), '') <> 'reached'
  `).run(sessionId);
}

/** Whether every turn this session ran was refused before its engine, so it did no work at all. */
export function neverReachedEngine(session: Pick<Session, "transportMeta">): boolean {
  return (session.transportMeta as Record<string, unknown> | null | undefined)?.[ENGINE_REACH_META_KEY] === "never";
}
