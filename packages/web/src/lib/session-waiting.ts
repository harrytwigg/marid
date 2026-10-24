/**
 * A session in the `waiting` status is paused, not working and not failed: it is
 * sitting out an engine usage limit (it resumes by itself when the window reopens),
 * or waiting for a remote host to come up. Every place that paints a session's state
 * uses these, so the pause reads the same everywhere and never as a running (blue)
 * or failed (red) session.
 */

/** Amber, not red: nothing has failed. */
export const SESSION_WAITING_COLOR = "var(--system-yellow)"

export const SESSION_WAITING_LABEL = "Waiting"

const FALLBACK_REASON = "paused until the engine's usage limit resets"

export function isSessionWaiting(status: unknown): boolean {
  return status === "waiting"
}

/** The dot's tooltip. The gateway writes the reason, and the resume time where it
 *  knows one, into the session's `lastError` when it parks the session. */
export function sessionWaitingTitle(lastError?: unknown): string {
  const reason = typeof lastError === "string" ? lastError.trim() : ""
  return `${SESSION_WAITING_LABEL}: ${reason || FALLBACK_REASON}`
}
