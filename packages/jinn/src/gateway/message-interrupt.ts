import { isCompactCommand } from "../shared/skill-commands.js";

/** How one operator message should arrive while a turn is running. */
export type MessageDelivery = "queue" | "now";

/**
 * The caller's explicit choice wins over the global default: `"queue"` never
 * interrupts, `"now"` always does. Anything else (including the legacy
 * `interrupt` boolean, mapped by the caller) falls back to
 * `sessions.interruptOnNewMessage`.
 */
export function resolveMessageDelivery(o: {
  delivery?: unknown;
  interrupt?: unknown;
}): MessageDelivery | undefined {
  if (o.delivery === "queue" || o.delivery === "now") return o.delivery;
  if (o.interrupt === true) return "now";
  if (o.interrupt === false) return "queue";
  return undefined;
}

/**
 * Whether a message arriving mid-turn cuts that turn off. An operator message
 * does by default (`sessions.interruptOnNewMessage`); a notification — a child
 * callback, a relay — never does. Nor does `/compact`: it waits for the running
 * turn, since cutting work off to compact it would lose the very turn the
 * summary should include. Nor does anything while the running turn is still
 * auto-compacting a cold session in front of its own message: cut
 * off, that compaction is wasted and the next turn starts it over.
 * An explicit per-message `delivery` overrides the global default in both
 * directions, subject to those same guards.
 */
export function shouldInterruptRunningTurn(o: {
  isNotification: boolean;
  prompt: string;
  interruptOnNewMessage: boolean | undefined;
  turnRunning: boolean;
  /** The running turn is auto-compacting before its message. */
  autoCompacting?: boolean;
  /** Per-message choice; overrides `interruptOnNewMessage` when set. */
  delivery?: MessageDelivery;
}): boolean {
  if (o.isNotification || !o.turnRunning || o.autoCompacting) return false;
  if (isCompactCommand(o.prompt)) return false;
  if (o.delivery === "queue") return false;
  if (o.delivery === "now") return true;
  return o.interruptOnNewMessage ?? true;
}
