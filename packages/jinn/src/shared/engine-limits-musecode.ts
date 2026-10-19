import type { EngineLimitEngineSnapshot, EngineLimitWindow, JinnConfig } from "./types.js";
import { baseSnapshot, isoFromSeconds } from "./engine-limits-util.js";
import { readMusecodeUsage } from "./musecode-usage.js";
import type { MuseUsageSnapshot } from "../engines/musecode-turn.js";

/**
 * Muse Code's subscription usage: a five-hour-class window and a weekly block,
 * as the provider reports them to the host.
 *
 * The only source is the last `usage/changed` a turn's host reported, kept in
 * `tmp/musecode-usage.json`. `muse serve` answers `usage/read` only for usage
 * it has itself observed, and a host started just to be asked has observed
 * none (checked on 1.4.8), so asking would spawn the binary for nothing.
 * Whether a `usage/read` against real credentials ever answers is unverified,
 * and is not read here. The numbers are "as of" the host's `observedAtMs`,
 * and a snapshot whose window has since reset, or that is simply old, says so
 * with `stale`.
 */

/** A snapshot this old no longer describes the account, whatever its windows say. */
export const MUSECODE_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const MUSECODE_NO_USAGE_REASON =
  "Muse Code reports usage once a turn has run. Usage appears here after the first Muse Code turn.";

function windowName(mins: number): string {
  if (mins <= 0) return "5h";
  return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}

function windowsOf(usage: MuseUsageSnapshot): EngineLimitWindow[] {
  const windowResets = Math.floor(usage.window.resetsAtMs / 1000);
  const weeklyResets = Math.floor(usage.weekly.resetsAtMs / 1000);
  return [
    {
      name: windowName(usage.window.windowDurationMins),
      usedPercent: usage.window.usedPercent,
      windowDurationMins: usage.window.windowDurationMins || undefined,
      resetsAt: windowResets,
      resetsAtIso: isoFromSeconds(windowResets),
    },
    { name: "weekly", usedPercent: usage.weekly.usedPercent, resetsAt: weeklyResets, resetsAtIso: isoFromSeconds(weeklyResets) },
  ];
}

export function isStaleMusecodeUsage(usage: MuseUsageSnapshot, nowMs: number): boolean {
  return nowMs - usage.observedAtMs > MUSECODE_SNAPSHOT_MAX_AGE_MS
    || nowMs >= usage.window.resetsAtMs
    || nowMs >= usage.weekly.resetsAtMs;
}

export function collectMusecodeLimits(config: JinnConfig, nowMs: number = Date.now()): EngineLimitEngineSnapshot {
  const snap = baseSnapshot(config, "musecode");
  if (!snap.available) return { ...snap, status: "unavailable", unsupportedReason: "Muse Code CLI is not installed." };
  const kept = readMusecodeUsage();
  if (!kept) return { ...snap, status: "unavailable", source: "muse usage/changed", unsupportedReason: MUSECODE_NO_USAGE_REASON };
  return {
    ...snap,
    status: "snapshot",
    source: "muse usage/changed",
    refreshedAt: new Date(kept.observedAtMs).toISOString(),
    accountPlan: kept.tier || undefined,
    windows: windowsOf(kept),
    stale: isStaleMusecodeUsage(kept, nowMs),
  };
}
