import { isCompactCommand } from "../shared/skill-commands.js";

/**
 * Whether a message arriving mid-turn cuts that turn off. An operator message
 * does by default (`sessions.interruptOnNewMessage`); a notification — a child
 * callback, a relay — never does. Nor does `/compact`: it waits for the running
 * turn, since cutting work off to compact it would lose the very turn the
 * summary should include. Nor does anything while the running turn is still
 * auto-compacting a cold session in front of its own message: cut
 * off, that compaction is wasted and the next turn starts it over.
 */
export function shouldInterruptRunningTurn(o: {
  isNotification: boolean;
  prompt: string;
  interruptOnNewMessage: boolean | undefined;
  turnRunning: boolean;
  /** The running turn is auto-compacting before its message. */
  autoCompacting?: boolean;
}): boolean {
  if (o.isNotification || !o.turnRunning || o.autoCompacting) return false;
  if (isCompactCommand(o.prompt)) return false;
  return o.interruptOnNewMessage ?? true;
}
