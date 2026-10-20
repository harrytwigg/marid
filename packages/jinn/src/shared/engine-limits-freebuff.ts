import type { EngineLimitEngineSnapshot, EngineLimitWindow, JinnConfig } from "./types.js";
import { baseSnapshot } from "./engine-limits-util.js";
import { readFreebuffUsage, type FreebuffUsageSnapshot } from "./freebuff-usage.js";

/**
 * Freebuff's allowance is hours, not money: a daily balance (`17/21 hours
 * remaining`) and the minutes left in the running hour session. Both come off the
 * CLI's screen, so they are "as of" the last turn that read it, and a snapshot
 * older than a day says nothing about today.
 */

/** The daily balance resets on a day's clock; older than this describes yesterday. */
export const FREEBUFF_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The session clock is an hour long; a reading older than that describes a session that is over. */
const SESSION_READING_MAX_AGE_MS = 60 * 60 * 1000;

export const FREEBUFF_NO_USAGE_REASON =
  "Freebuff shows its hours on screen once a turn has run. Usage appears here after the first Freebuff turn.";

function windowsOf(usage: FreebuffUsageSnapshot, nowMs: number): EngineLimitWindow[] {
  const windows: EngineLimitWindow[] = [];
  if (usage.hoursRemaining !== undefined && usage.hoursTotal) {
    const used = Math.max(0, usage.hoursTotal - usage.hoursRemaining);
    windows.push({ name: "daily hours", usedPercent: Math.min(100, (used / usage.hoursTotal) * 100), windowDurationMins: 24 * 60 });
  }
  if (usage.sessionLeftMinutes !== undefined && nowMs - usage.observedAtMs < SESSION_READING_MAX_AGE_MS) {
    windows.push({ name: "session", usedPercent: Math.max(0, 100 - (usage.sessionLeftMinutes / 60) * 100), windowDurationMins: 60 });
  }
  return windows;
}

export function collectFreebuffLimits(config: JinnConfig, nowMs: number = Date.now()): EngineLimitEngineSnapshot {
  const snap = baseSnapshot(config, "freebuff");
  if (!snap.available) return { ...snap, status: "unavailable", unsupportedReason: "Freebuff CLI is not installed." };
  const kept = readFreebuffUsage();
  if (!kept) return { ...snap, status: "unavailable", source: "freebuff screen", unsupportedReason: FREEBUFF_NO_USAGE_REASON };
  return {
    ...snap,
    status: "snapshot",
    source: "freebuff screen",
    refreshedAt: new Date(kept.observedAtMs).toISOString(),
    ...(kept.hoursRemaining !== undefined && kept.hoursTotal !== undefined ? { accountPlan: `${kept.hoursRemaining}/${kept.hoursTotal} hours left today` } : {}),
    windows: windowsOf(kept, nowMs),
    stale: nowMs - (kept.hoursObservedAtMs ?? kept.observedAtMs) > FREEBUFF_SNAPSHOT_MAX_AGE_MS,
  };
}
