/** Mirrors terminals/session.ts on the gateway: a terminal session carries
 *  "terminal" as both its engine (which pane meta already has) and its source. */
export const TERMINAL_SESSION_ENGINE = "terminal"

export function isTerminalSession(session: { engine?: unknown; source?: unknown } | null | undefined): boolean {
  return session?.engine === TERMINAL_SESSION_ENGINE || session?.source === TERMINAL_SESSION_ENGINE
}
