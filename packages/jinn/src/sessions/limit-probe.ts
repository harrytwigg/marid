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
const listeners = new Set<(sessionId: string) => void>();

/** Called when a session starts or stops being reported as probing, so the gateway can tell
 *  clients its status changed (nothing is written to the session row when a probe ends). */
export function onLimitProbeChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed(sessionId: string): void {
  for (const listener of listeners) {
    try { listener(sessionId); } catch { /* a listener must not break the retry */ }
  }
}

export function beginLimitProbe(sessionId: string): void {
  if (probing.has(sessionId)) return;
  probing.add(sessionId);
  changed(sessionId);
}

/** True when the session was probing. */
export function endLimitProbe(sessionId: string): boolean {
  const was = probing.delete(sessionId);
  if (was) changed(sessionId);
  return was;
}

export function isProbingLimit(sessionId: string): boolean {
  return probing.has(sessionId);
}
