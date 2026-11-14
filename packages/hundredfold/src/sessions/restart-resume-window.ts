import { initDb } from "../shared/db.js";
import type { Session, SessionAttemptOutcome } from "../shared/types.js";
import { RESTART_ACK_META_KEY, RESTART_RESUME_META_KEY, isStaleRestartAcknowledgement } from "./registry.js";

/** The restart resume nudge planned for a session: when it is due, and the attempt it resumes.
 *  Written as the boot plans the nudges, after it has consumed RESTART_RESUME_META_KEY. It speaks
 *  only for that attempt: a later turn mints a new token, and a stop or reset bumps the version.
 *  Lives here rather than beside its siblings in registry.ts, which is over its size budget. */
export const RESTART_RESUME_DUE_META_KEY = "restartResumeDue";

/**
 * How long past its due time a planned restart nudge still speaks for its
 * session. The nudge fires on its timer and the turn starts within seconds, so
 * this only has to cover a delivery that is slow to land. A nudge that never
 * lands (the gateway died again, the delivery keeps failing) stops counting
 * once it has passed, and the Todo then derives `blocked` as before.
 */
export const RESTART_RESUME_DUE_GRACE_MS = 2 * 60_000;

/** The slice of a session the window reads. */
export type RestartResumeEvidence = Pick<Session, "attemptOutcome" | "transportMeta" | "attemptToken" | "attemptTerminalVersion">;

interface ResumeDue {
  dueAt: string;
  attemptToken: string | null;
  attemptTerminalVersion: number;
}

function meta(session: RestartResumeEvidence): Record<string, unknown> {
  const value = session.transportMeta;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readDue(session: RestartResumeEvidence): ResumeDue | undefined {
  const due = meta(session)[RESTART_RESUME_DUE_META_KEY];
  if (!due || typeof due !== "object" || Array.isArray(due)) return undefined;
  const { dueAt, attemptToken, attemptTerminalVersion } = due as Record<string, unknown>;
  if (typeof dueAt !== "string" || typeof attemptTerminalVersion !== "number") return undefined;
  if (attemptToken !== null && typeof attemptToken !== "string") return undefined;
  return { dueAt, attemptToken, attemptTerminalVersion };
}

/** Record when the restart resume nudge planned for this session is due, against the attempt as
 *  it stands now. The caller settles the attempt token first, exactly as the nudge will. */
export function stampRestartResumeDue(sessionId: string, dueAt: string): void {
  const database = initDb();
  const row = database.prepare("SELECT attempt_token, attempt_terminal_version FROM sessions WHERE id = ?")
    .get(sessionId) as { attempt_token: string | null; attempt_terminal_version: number } | undefined;
  if (!row) return;
  const due: ResumeDue = { dueAt, attemptToken: row.attempt_token, attemptTerminalVersion: row.attempt_terminal_version };
  database
    .prepare(`UPDATE sessions SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${RESTART_RESUME_DUE_META_KEY}', json(?)) WHERE id = ?`)
    .run(JSON.stringify(due), sessionId);
}

/** Drop the stamp: nothing is going to resume the session after all. */
export function clearRestartResumeDue(sessionId: string): void {
  initDb()
    .prepare(`UPDATE sessions SET transport_meta = NULLIF(json_remove(transport_meta, '$.${RESTART_RESUME_DUE_META_KEY}'), '{}') WHERE id = ?`)
    .run(sessionId);
}

/**
 * Whether the gateway is about to resume a turn a restart interrupted, so the
 * turn is still in flight rather than settled.
 *
 * A restart marks the session `interrupted` well before anything starts its
 * turn again. Read as a settled interruption in that window, it moves the Todo
 * it works to `blocked`, which wakes the parent's owner and closes the run
 * `abandoned`, and seconds later the resumed turn moves the Todo back to
 * `executing`. The window has three parts, in boot order:
 *
 * - A session that asked for the restart carries a fresh acknowledgement
 *   until the boot consumes it (`acknowledgeRestartRequesters`), turning it
 *   into the mark below or dropping it (loop guard, stale request).
 * - The restart-resume mark, from the interruption (`recoverStaleSessions` at
 *   boot, or the graceful shutdown sweep) until the boot consumes it, right
 *   after the pending queue replay has restarted its sessions.
 * - The due stamp the boot writes as it plans each nudge, for that attempt
 *   only, until the nudge is due plus {@link RESTART_RESUME_DUE_GRACE_MS}.
 *
 * Only an `interrupted` receipt counts. A session the restart leaves alone (the
 * nudges are off, it is a board walk turn, it is over the cap, its nudge was
 * not claimed) carries none of these once the boot is through, and derives
 * `blocked` on the next sweep. A turn the operator stops or resets is a new
 * receipt the stamp does not speak for.
 */
export function awaitsRestartResume(session: RestartResumeEvidence, now: number = Date.now()): boolean {
  if (session.attemptOutcome !== "interrupted") return false;
  return markedForResume(session, now) || dueStampHolds(session, now);
}

/** The first two parts of the window: a fresh restart request, or the restart-resume mark. */
function markedForResume(session: RestartResumeEvidence, now: number): boolean {
  const fields = meta(session);
  if (typeof fields[RESTART_RESUME_META_KEY] === "string") return true;
  const ack = fields[RESTART_ACK_META_KEY];
  return typeof ack === "string" && !isStaleRestartAcknowledgement(ack, now);
}

/** The third part: the nudge stamped for this very attempt is not yet past its grace. */
function dueStampHolds(session: RestartResumeEvidence, now: number): boolean {
  const due = readDue(session);
  if (!due) return false;
  const sameAttempt = due.attemptToken === (session.attemptToken ?? null)
    && due.attemptTerminalVersion === (session.attemptTerminalVersion ?? 0);
  const dueAt = Date.parse(due.dueAt);
  return sameAttempt && Number.isFinite(dueAt) && now <= dueAt + RESTART_RESUME_DUE_GRACE_MS;
}

/** The receipt a reader should settle on: none while the gateway is about to resume the turn. */
export function settledAttemptOutcome(session: RestartResumeEvidence, now: number = Date.now()): SessionAttemptOutcome | null {
  if (!session.attemptOutcome || awaitsRestartResume(session, now)) return null;
  return session.attemptOutcome;
}
