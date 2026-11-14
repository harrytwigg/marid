import type { GatewayEmit, GatewayEventMap } from "../shared/gateway-events.js";
import type { Session } from "../shared/types.js";
import { effectiveSessionStatus, isBackgroundWorkLive, runtimeTransportRunning, serializeRuntimeActivity, type RuntimeActivityInfo } from "../sessions/background-work.js";

/** How often background work may move a session's stored lastActivity. The
 *  serialized session reads the live value; the stored one only has to keep
 *  the registry's readers (Todo recovery, the session list's ordering) from
 *  seeing a working session as stale, so it need not track every hook. */
const LAST_ACTIVITY_WRITE_MS = 5_000;

export interface RuntimeActivityDeps {
  activity: Map<string, RuntimeActivityInfo>;
  getSession(sessionId: string): Session | undefined;
  /** The queue's transport state for the session, before runtime activity. */
  transportState(session: Session): NonNullable<Session["transportState"]>;
  setLastActivity(sessionId: string, iso: string): void;
  emit: GatewayEmit;
}

/**
 * The gateway's consumer of an engine's post-settle runtime activity: keeps
 * the in-memory activity map current, advances the session's stored
 * lastActivity while background work runs, and tells clients the session's
 * status and transport state as the overlay now reports them.
 */
export function createRuntimeActivityHandler(deps: RuntimeActivityDeps): (sessionId: string, info: RuntimeActivityInfo | null) => void {
  const working = new Set<string>();
  return (sessionId, info) => {
    const current = info ?? undefined;
    if (current) deps.activity.set(sessionId, current);
    else deps.activity.delete(sessionId);
    const wasLive = working.has(sessionId);
    const live = isBackgroundWorkLive(current);
    if (live) working.add(sessionId);
    else working.delete(sessionId);
    const session = deps.getSession(sessionId);
    if (session && current && (live || wasLive)) recordLastActivity(deps, session, current, live);
    deps.emit("session:background", backgroundEvent(deps, sessionId, session, current));
  };
}

function backgroundEvent(
  deps: RuntimeActivityDeps,
  sessionId: string,
  session: Session | undefined,
  info: RuntimeActivityInfo | undefined,
): GatewayEventMap["session:background"] {
  const base = session ? deps.transportState(session) : "idle";
  const busy = runtimeTransportRunning(info) && base !== "error" && base !== "interrupted";
  return {
    sessionId,
    transportState: busy ? "running" : base,
    ...(session ? { status: effectiveSessionStatus(session, info) } : {}),
    backgroundActivity: info ? serializeRuntimeActivity(info) : null,
  };
}

/** Move the stored lastActivity with background work. Only while the stored
 *  status is idle: a gateway turn's own heartbeat owns it while that runs. The
 *  write that ends the work is never throttled, so the stored value says when
 *  it ended. */
function recordLastActivity(deps: RuntimeActivityDeps, session: Session, info: RuntimeActivityInfo, live: boolean): void {
  if (session.status !== "idle") return;
  const stored = Date.parse(session.lastActivity) || 0;
  if (info.lastActivityAt - stored >= LAST_ACTIVITY_WRITE_MS || (!live && info.lastActivityAt > stored)) {
    deps.setLastActivity(session.id, new Date(info.lastActivityAt).toISOString());
  }
}
