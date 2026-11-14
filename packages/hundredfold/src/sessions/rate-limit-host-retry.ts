/**
 * When the place a usage-limit retry runs is not ready at the reset.
 *
 * A remote employee's retry is a fresh spawn on its host, and the host can be
 * asleep, still booting, or off the network at exactly the moment the limit
 * lifts. That is not a reason to give the turn up: the wait-and-retry loop
 * tries again with backoff until the host answers, and only gives up once a
 * bounded window has passed, failing the turn where someone will see it.
 *
 * The readiness failure arrives one of two ways: the turn layer's pre-retry gate
 * (which wakes the host and waits for its mount) reports it, or the engine's own
 * last-moment check before spawning throws it. Both are recognised by their text.
 */

/** First backoff after a failed retry; doubles per failure. */
export const HOST_RETRY_BASE_DELAY_MS = 60_000;
/** Backoff cap: once reached, the host is tried every half hour. */
export const HOST_RETRY_MAX_DELAY_MS = 30 * 60_000;
/** How long after the first failure the loop keeps trying. Long enough to cover
 *  a workstation that is off overnight. */
export const HOST_RETRY_WINDOW_MS = 12 * 60 * 60_000;

/** The error texts a not-ready host produces: the engines' pre-spawn check and
 *  the turn layer's wake-and-wait gate. */
const HOST_NOT_READY = /^(remote host not ready|remote host unavailable):/i;

export function isHostNotReadyError(error: unknown): boolean {
  return typeof error === "string" && HOST_NOT_READY.test(error.trim());
}

/** The message of a thrown engine failure, when it is a host that was not ready. */
export function hostNotReadyFromThrown(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  return message !== undefined && isHostNotReadyError(message) ? message : undefined;
}

export function hostRetryDelayMs(failures: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(HOST_RETRY_BASE_DELAY_MS * 2 ** Math.min(exponent, 16), HOST_RETRY_MAX_DELAY_MS);
}

export type HostRetryStep =
  | { exhausted: false; delayMs: number; retryAt: Date; failures: number }
  | { exhausted: true; failures: number; since: Date };

/**
 * One streak of not-ready retries. A retry that reaches the engine (whatever it
 * answers) ends the streak, so a later outage starts a fresh window.
 */
export class HostRetryStreak {
  private failures = 0;
  private firstAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record a failed attempt and say when to try next, or that the window is spent. */
  fail(): HostRetryStep {
    const now = this.now();
    if (this.failures === 0) this.firstAt = now;
    this.failures++;
    const delayMs = hostRetryDelayMs(this.failures);
    const boundAt = this.firstAt + HOST_RETRY_WINDOW_MS;
    if (now >= boundAt) return { exhausted: true, failures: this.failures, since: new Date(this.firstAt) };
    // The last try lands on the bound rather than past it.
    const nextAt = Math.min(now + delayMs, boundAt);
    return { exhausted: false, delayMs: nextAt - now, retryAt: new Date(nextAt), failures: this.failures };
  }

  /** The host answered: forget the streak. */
  reset(): void {
    this.failures = 0;
    this.firstAt = 0;
  }

  /** Whether a streak is open. It keeps the loop alive past the limit's own
   *  deadline; {@link fail} is what ends it, at the window's bound. */
  active(): boolean {
    return this.failures > 0;
  }

  get count(): number {
    return this.failures;
  }
}
