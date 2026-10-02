import type { Session } from "../shared/types.js";

/**
 * Post-settle runtime activity an engine reports for a session: work still
 * happening after the gateway's turn ended. In memory only; the engine is its
 * source of truth and a restart forgets it with the engine processes.
 */
export interface RuntimeActivityInfo {
  activeStreams: number;
  /** Tool-bearing model requests in flight (main agent + sub-agents). */
  activeAgents?: number;
  /** Background shell tasks the engine has not seen finish. */
  activeMonitors?: number;
  /** Background sub-agents launched and not yet reported finished. */
  backgroundAgents?: number;
  /** The engine re-invoked the model on its own (a finished background task's
   *  notification) and that re-run has not ended. */
  backgroundRerun?: boolean;
  lastActivityAt: number;
}

/**
 * Whether a session's post-settle activity is work in progress, so the session
 * reports `running` rather than `idle`: a background sub-agent not yet
 * reported finished, or the re-run a finished one woke.
 *
 * Both have an announced end, so the session reads `idle` the moment they are
 * over. Nothing else counts on its own. A background shell task may never end
 * (a dev server, a log tail), and counting it would pin the session at
 * `running` until its process died, hiding a real stall from every check that
 * reads status. A model request in flight has no announced end beyond its own
 * response, and the requests a turn's tail sends after its Stop would hold
 * every finished turn at `running`; requests only make the transport busy
 * (runtimeTransportRunning).
 */
export function isBackgroundWorkLive(info: RuntimeActivityInfo | undefined): boolean {
  if (!info) return false;
  return info.backgroundRerun === true || (info.backgroundAgents ?? 0) > 0;
}

/** Whether the transport is busy: any model request in flight, auxiliary ones
 *  included, or live background work between requests. Wider than
 *  isBackgroundWorkLive, which decides the status every reader acts on. */
export function runtimeTransportRunning(info: RuntimeActivityInfo | undefined): boolean {
  return !!info && (info.activeStreams > 0 || isBackgroundWorkLive(info));
}

/**
 * The gateway's per-session runtime activity, kept current from the engines'
 * runtime-activity callbacks (server.ts). A module-level map because the Todo
 * recovery sweep reads session liveness from the registry, far from the API
 * context that carries it to the session list.
 */
export const runtimeActivity = new Map<string, RuntimeActivityInfo>();

export function hasLiveBackgroundWork(sessionId: string): boolean {
  return isBackgroundWorkLive(runtimeActivity.get(sessionId));
}

/** effectiveSessionStatus for a session read from the registry, against the
 *  gateway's runtime activity. */
export function reportedSessionStatus(session: Pick<Session, "id" | "status">): Session["status"] {
  return effectiveSessionStatus(session, runtimeActivity.get(session.id));
}

/**
 * The status to report for a session. The stored status stays `idle` while
 * background work runs: the transcript sync that records a background re-run's
 * reply skips sessions stored as `running`, and the status reconciler would
 * settle one with no turn in flight as interrupted. So the overlay is applied
 * where status is read, not written.
 */
export function effectiveSessionStatus(
  session: Pick<Session, "status">,
  info: RuntimeActivityInfo | undefined,
): Session["status"] {
  return session.status === "idle" && isBackgroundWorkLive(info) ? "running" : session.status;
}

/** The activity as the API and the `session:background` event carry it. */
export function serializeRuntimeActivity(bg: RuntimeActivityInfo): NonNullable<Session["backgroundActivity"]> {
  return {
    activeStreams: bg.activeStreams,
    ...(bg.activeAgents !== undefined ? { activeAgents: bg.activeAgents } : {}),
    ...(bg.activeMonitors !== undefined ? { activeMonitors: bg.activeMonitors } : {}),
    ...(bg.backgroundAgents !== undefined ? { backgroundAgents: bg.backgroundAgents } : {}),
    ...(bg.backgroundRerun !== undefined ? { backgroundRerun: bg.backgroundRerun } : {}),
    lastActivityAt: new Date(bg.lastActivityAt).toISOString(),
  };
}
