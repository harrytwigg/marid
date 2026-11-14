// Cutting a session's turn short. A leaf module: the stop route, the board walk
// and the stop's own bookkeeping (`session-stop.ts`) all reach it, and none of
// them may pull `api.ts` in behind it.
import type { Engine, Session } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { updateSession } from "../sessions/registry.js";
import type { ApiContext } from "./api.js";

export function killSessionEngines(context: ApiContext, session: Session, reason: string): void {
  const engines = new Set<Engine>();
  const primary = context.sessionManager.getEngine(session.engine);
  const pty = context.ptyViewEngines?.[session.engine];
  if (primary) engines.add(primary);
  if (pty) engines.add(pty);
  for (const engine of context.sessionManager.getEngines().values()) engines.add(engine);
  for (const engine of Object.values(context.ptyViewEngines ?? {})) engines.add(engine);

  for (const engine of engines) {
    if (isInterruptibleEngine(engine)) engine.kill(session.id, reason);
  }
  // Reached for a terminal only on delete: /stop and /reset refuse terminals.
  context.terminalEngine?.forget(session.id);
}

/** Stop a session's turn the way `POST /api/sessions/:id/stop` does: kill its
 *  engines, clear its queue, and leave the record interrupted (recoverable).
 *  Shared with the board walk, which stops its own turn when it times out. */
export function interruptSessionTurn(context: ApiContext, session: Session, reason: string, lastError: string): void {
  killSessionEngines(context, session, reason);
  context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
  updateSession(session.id, { status: "interrupted", attemptOutcome: "interrupted", lastActivity: new Date().toISOString(), lastError });
  context.emit("session:stopped", { sessionId: session.id });
}

