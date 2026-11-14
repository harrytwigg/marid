import { removeCodexSessionHome } from "../engines/codex.js";
import { disarmHeartbeatsForSession } from "../heartbeats/store.js";

/**
 * What a deleted session leaves behind outside its own rows: the per-session
 * Codex CODEX_HOME overlay, which holds a session-scoped capability in its
 * config.toml, and any heartbeats it armed, which have no owner left to fire
 * into. Both are idempotent and a no-op for a session that never had them.
 */
export function cleanUpDeletedSession(sessionId: string): void {
  removeCodexSessionHome(sessionId);
  disarmHeartbeatsForSession(sessionId);
}
