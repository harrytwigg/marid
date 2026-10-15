import type { EngineLimitEngineSnapshot, EngineLimitWindow, JinnConfig } from "./types.js";
import { baseSnapshot, isoFromSeconds } from "./engine-limits-util.js";
import { resolveBin } from "./resolve-bin.js";
import { readMusecodeUsage } from "./musecode-usage.js";
import { askMuseHost } from "../engines/musecode-probe.js";
import type { MuseUsageSnapshot } from "../engines/musecode-turn.js";

/**
 * Muse Code's subscription usage: a five-hour-class window and a weekly block,
 * as the provider reports them to the host.
 *
 * Two sources, in order. A short-lived `muse serve` is asked (`usage/read`),
 * which answers only when that process has itself seen usage. A fresh host
 * has not, so in practice the answer is the last `usage/changed` a turn's host
 * reported, kept in `tmp/musecode-usage.json`. Either way the numbers are
 * "as of" the host's `observedAtMs`, and a snapshot whose window has since
 * reset, or that is simply old, says so with `stale`.
 */

const LIVE_READ_TIMEOUT_MS = 10_000;
/** A snapshot this old no longer describes the account, whatever its windows say. */
export const MUSECODE_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const MUSECODE_NO_USAGE_REASON =
  "Muse Code reports usage once a turn has run. Usage appears here after the first Muse Code turn.";

/** `usage/read`'s `usage`, when it carries one the collector can use. */
function parseUsage(result: Record<string, unknown> | undefined): MuseUsageSnapshot | undefined {
  const usage = result?.usage as Partial<MuseUsageSnapshot> | undefined;
  if (!usage || typeof usage !== "object" || !usage.window || !usage.weekly) return undefined;
  const { window, weekly } = usage;
  if (![usage.observedAtMs, window.usedPercent, window.resetsAtMs, weekly.usedPercent, weekly.resetsAtMs].every(Number.isFinite)) return undefined;
  return {
    observedAtMs: usage.observedAtMs!,
    tier: typeof usage.tier === "string" ? usage.tier : "",
    window: { usedPercent: window.usedPercent, windowDurationMins: Number(window.windowDurationMins) || 0, resetsAtMs: window.resetsAtMs },
    weekly: { usedPercent: weekly.usedPercent, resetsAtMs: weekly.resetsAtMs },
  };
}

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

export async function collectMusecodeLimits(config: JinnConfig, nowMs: number = Date.now()): Promise<EngineLimitEngineSnapshot> {
  const snap = baseSnapshot(config, "musecode");
  if (!snap.available) return { ...snap, status: "unavailable", unsupportedReason: "Muse Code CLI is not installed." };

  const bin = resolveBin("muse", config.engines.musecode?.bin);
  const live = parseUsage(await askMuseHost(bin, { timeoutMs: LIVE_READ_TIMEOUT_MS }, (client) => client.request("usage/read", {}, { timeoutMs: LIVE_READ_TIMEOUT_MS })));
  if (live) {
    return { ...snap, status: "live", source: "muse usage/read", refreshedAt: new Date(live.observedAtMs).toISOString(), accountPlan: live.tier || undefined, windows: windowsOf(live) };
  }

  const kept = readMusecodeUsage();
  if (kept) {
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
  return { ...snap, status: "unavailable", source: "muse usage/changed", unsupportedReason: MUSECODE_NO_USAGE_REASON };
}
