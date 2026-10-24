/**
 * A session parked on a usage limit wakes up now and then to ask the engine
 * whether the limit has lifted. While that probe is in flight the stored status is
 * `running` (a stop must still reach the engine process), but nothing has resumed:
 * a probe against a limit that is still up can hang for many minutes before it
 * fails. The session is reported as `waiting` until the probe shows real output,
 * and only then as `running`.
 *
 * In memory on purpose: the probe cannot outlive the process that runs it.
 */
const probing = new Set<string>();

export function beginLimitProbe(sessionId: string): void {
  probing.add(sessionId);
}

/** True when the session was probing, so the caller knows to tell clients it changed. */
export function endLimitProbe(sessionId: string): boolean {
  return probing.delete(sessionId);
}

export function isProbingLimit(sessionId: string): boolean {
  return probing.has(sessionId);
}
