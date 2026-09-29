/**
 * Terminals opened from the host menu take the keyboard as soon as they mount,
 * so a new shell's startup queries are answered. Only those: a grid
 * reload remounting several terminals must not have the last one steal focus.
 */
const pending = new Set<string>()

export function focusTerminalWhenMounted(sessionId: string): void {
  pending.add(sessionId)
}

/** True once, for a terminal marked by the host menu. */
export function takeTerminalFocus(sessionId: string): boolean {
  return pending.delete(sessionId)
}
