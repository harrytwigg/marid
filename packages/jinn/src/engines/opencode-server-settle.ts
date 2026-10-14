/**
 * When a server turn that has no answer yet may end, and what it says when it
 * ends without one because the provider failed.
 *
 * opencode does not give up on a provider at the first error. It retries in
 * place, reporting each attempt as a `retry` session status that carries the
 * provider's message (verified on 1.18.35 and 1.19.0 with a provider answering
 * 429 "Go usage limit exceeded": retry, busy, retry, … then, out of attempts,
 * session.error, idle, the failed reply's message.updated). A plugin or
 * provider can also fall back to another model: a newer reply to the turn's
 * prompt opens, or the prompt is re-sent (see repeatsPrompt). So an idle, or
 * a finished reply with no text, is only the end of a turn that has no answer
 * once nothing has taken the turn up again for a short while.
 */

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** What opencode says while it retries a provider: the provider's message,
 *  and when (epoch ms) it will try again. */
export interface ProviderRetry {
  message: string;
  next?: number;
}

/** The retry a `session.status` reports, if it is one. */
export function providerRetryOf(status: Record<string, unknown> | undefined): ProviderRetry | undefined {
  if (str(status?.type) !== "retry") return undefined;
  const message = str(status?.message) ?? "the provider failed and opencode is retrying it";
  return typeof status?.next === "number" ? { message, next: status.next } : { message };
}

/** The error of a turn that ended with no answer while opencode was retrying
 *  its provider: the provider's own words first, then how the turn ended. */
export function providerFailureReason(retry: ProviderRetry, noAnswer: string): string {
  return `opencode's provider failed: ${retry.message}; ${noAnswer}`;
}

/** The error a turn ends with when opencode will not retry the provider for
 *  longer than the turn waits: a usage window rather than a blip. */
export function abandonedRetryError(retry: ProviderRetry, now = Date.now()): { name: string; data: { message: string } } {
  const minutes = retry.next ? Math.max(1, Math.round((retry.next - now) / 60_000)) : undefined;
  const when = minutes ? `; opencode would not retry it for ${minutes} min` : "";
  return { name: "ProviderError", data: { message: `${retry.message}${when}` } };
}

/**
 * Whether a part of a user message the turn did not post repeats the turn's
 * prompt word for word: a fallback re-sending it on another model. The
 * opencode-rate-limit plugin (1.4.0) does exactly that: on a rate-limit retry
 * or error it aborts the session and posts the last user message's text parts
 * again, without their metadata, as a new message on its fallback model (the
 * abort leaves the turn's reply completed, with no error and nothing written,
 * and the session idle; verified with opencode 1.19.0). The answer to that
 * copy is the turn's answer. A Jinn prompt always carries Jinn metadata, so
 * another Jinn turn's prompt is never taken for a copy.
 */
export function repeatsPrompt(part: Record<string, unknown>, promptText: string): boolean {
  const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata as Record<string, unknown> : undefined;
  return part.type === "text" && Boolean(promptText) && part.text === promptText && metadata?.jinn === undefined;
}

/**
 * Why the turn is waiting to end:
 * - `idle`: the session went idle without a text answer (or with its newest
 *   reply still open). A newer reply of the turn's, its re-sent prompt, or a
 *   retry of its own reply means opencode took the turn up again.
 * - `done`: one of the turn's replies finished without a text answer. The same
 *   signs mean it is not the last.
 * - `retry`: opencode will not retry the provider for longer than a turn
 *   waits. Anything that shows the turn moving on cancels it.
 */
export type SettleKind = "idle" | "done" | "retry";

/** One pending end, at most, with its own timer. */
export class SettleWait {
  private timer?: NodeJS.Timeout;
  private kind?: SettleKind;

  constructor(private readonly onExpire: (kind: SettleKind) => void) {}

  get pending(): SettleKind | undefined {
    return this.kind;
  }

  /** Start waiting, unless already waiting for the same reason (a repeated
   *  idle must not push the end back). A different reason replaces it. */
  arm(kind: SettleKind, ms: number): void {
    if (this.kind === kind) return;
    this.cancel();
    this.kind = kind;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kind = undefined;
      this.onExpire(kind);
    }, ms);
    this.timer.unref?.();
  }

  /** Stop waiting for any of `kinds` (for anything, given none). */
  cancel(...kinds: SettleKind[]): void {
    if (!this.kind || (kinds.length && !kinds.includes(this.kind))) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.kind = undefined;
  }
}
