import { isCompactCommand } from "../shared/skill-commands.js";

/**
 * Whether a message arriving mid-turn cuts that turn off. An operator message
 * does by default (`sessions.interruptOnNewMessage`); a notification — a child
 * callback, a relay — never does. Nor does `/compact`: it waits for the running
 * turn, since cutting work off to compact it would lose the very turn the
 * summary should include.
 */
export function shouldInterruptRunningTurn(o: {
  isNotification: boolean;
  prompt: string;
  interruptOnNewMessage: boolean | undefined;
  turnRunning: boolean;
}): boolean {
  if (o.isNotification || !o.turnRunning) return false;
  if (isCompactCommand(o.prompt)) return false;
  return o.interruptOnNewMessage ?? true;
}
