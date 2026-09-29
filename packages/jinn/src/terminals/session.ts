import type { Session } from "../shared/types.js";

/**
 * An operator terminal is a Session, so the sidebar, the chat grid,
 * pins, rename and delete all work on it unchanged. It is never an agent: no
 * engine turn runs in it, it takes no messages, and its only I/O is the PTY
 * behind `/ws/pty/:id`. Both fields carry the marker — `source` is what server
 * code branches on, `engine` is what the web's session meta already carries.
 *
 * `sourceRef` holds the terminal host id (see terminals/hosts.ts).
 */
export const TERMINAL_SESSION_SOURCE = "terminal";
export const TERMINAL_SESSION_ENGINE = "terminal";

export function isTerminalSession(session: Pick<Session, "source" | "engine"> | null | undefined): boolean {
  return session?.source === TERMINAL_SESSION_SOURCE || session?.engine === TERMINAL_SESSION_ENGINE;
}

export const TERMINAL_HAS_NO_TURN =
  "A terminal session has no turn to stop or reset; exit its shell, or delete the session to end it.";

export const TERMINAL_REFUSES_MESSAGES =
  "A terminal session takes keyboard input in its terminal; it never runs an agent turn or accepts messages.";
