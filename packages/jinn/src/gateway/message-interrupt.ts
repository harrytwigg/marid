import { isCompactCommand } from "../shared/skill-commands.js";

/** How one operator message should arrive while a turn is running. */
export type MessageDelivery = "queue" | "now";

/**
 * The caller's explicit choice wins over the global default: `"queue"` never
 * interrupts, `"now"` always does. The legacy `interrupt` boolean maps to the
 * same choice here; anything else falls back to
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
 * Why a `delivery` field is refused, or undefined when it is absent or valid.
 * A misspelt choice must not fall through to the default, which interrupts.
 */
export function messageDeliveryError(delivery: unknown): string | undefined {
  if (delivery === undefined || delivery === null || delivery === "queue" || delivery === "now") return undefined;
  return 'delivery must be "queue" or "now"';
}

/**
 * Whether a message arriving mid-turn cuts that turn off. An operator message
 * does by default (`sessions.interruptOnNewMessage`); a notification — a child
 * callback, a relay — never does. Nor does `/compact`: it waits for the running
 * turn, since cutting work off to compact it would lose the very turn the
 * summary should include. Nor does anything while the running turn is still
 * auto-compacting a cold session in front of its own message: cut
 * off, that compaction is wasted and the next turn starts it over. Nor does
 * anything while the queue is paused: nothing would drain, so cutting the turn
 * off would only lose its reply.
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
  /** The session's queue is paused. */
  queuePaused?: boolean;
}): boolean {
  if (o.isNotification || !o.turnRunning || o.autoCompacting || o.queuePaused) return false;
  if (isCompactCommand(o.prompt)) return false;
  if (o.delivery === "queue") return false;
  if (o.delivery === "now") return true;
  return o.interruptOnNewMessage ?? true;
}
