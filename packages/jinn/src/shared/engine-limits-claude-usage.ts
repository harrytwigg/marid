import type { EngineLimitWindow } from "./types.js";
import { isRecord, num, str, type JsonRecord } from "./engine-limits-util.js";

function usageWindow(name: string, percent: number, resetsAtIso: string | undefined, durationMins?: number): EngineLimitWindow {
  const parsed = resetsAtIso ? Date.parse(resetsAtIso) : NaN;
  const resetsAt = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
  return {
    name,
    usedPercent: Math.round(percent),
    windowDurationMins: durationMins,
    resetsAt,
    resetsAtIso: resetsAt !== undefined ? resetsAtIso : undefined,
  };
}

function limitLabel(kind: string, modelName: string | undefined): { name: string; durationMins?: number } {
  if (kind === "session") return { name: "5h", durationMins: 300 };
  if (kind === "weekly_all") return { name: "7d", durationMins: 10_080 };
  // Scoped buckets have no duration so the UI keeps their model in the label.
  if (kind === "weekly_scoped") return { name: modelName ? `7d ${modelName}` : "7d (scoped)" };
  return { name: modelName ? `${kind} ${modelName}` : kind };
}

export interface ClaudeUsageOptions {
  /** The account's newest statusline snapshot shows its plan has no five-hour
   *  limit (`statuslineShowsNoFiveHour`), so a five-hour reading of exactly 0
   *  is a bucket the plan does not have. */
  planHasNoFiveHour?: boolean;
}

/**
 * True when a five-hour reading is a bucket the plan does not have. Only an
 * exact zero can be: any reading above zero, however small, proves the limit
 * exists, so a used or exhausted session window always stands. A zero is left
 * out when the account's snapshot says the plan has no five-hour limit, or when
 * the payload itself says so: the entry is marked inactive, or the same
 * response's named buckets carry a weekly reading and no five-hour one.
 */
function fiveHourIsInapplicable(percent: number, item: JsonRecord | undefined, usage: JsonRecord, options: ClaudeUsageOptions): boolean {
  if (percent !== 0) return false;
  if (options.planHasNoFiveHour) return true;
  if (!item) return false;
  if (item.is_active === false) return true;
  return isRecord(usage.seven_day) && !isRecord(usage.five_hour);
}

function windowFromLimit(item: unknown, usage: JsonRecord, options: ClaudeUsageOptions): EngineLimitWindow | undefined {
  if (!isRecord(item)) return undefined;
  const percent = num(item.percent);
  if (percent === undefined) return undefined;
  if (item.kind === "session" && fiveHourIsInapplicable(percent, item, usage, options)) return undefined;
  const scope = isRecord(item.scope) ? item.scope : undefined;
  const model = scope && isRecord(scope.model) ? scope.model : undefined;
  const modelName = model ? str(model.display_name) : undefined;
  const label = limitLabel(str(item.kind) ?? "limit", modelName);
  return usageWindow(label.name, percent, str(item.resets_at), label.durationMins);
}

function windowFromNamedBucket([key, value]: [string, unknown], usage: JsonRecord, options: ClaudeUsageOptions): EngineLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const utilization = num(value.utilization);
  if (utilization === undefined) return undefined;
  const resetsAtIso = str(value.resets_at);
  if (key === "five_hour") {
    return fiveHourIsInapplicable(utilization, undefined, usage, options) ? undefined : usageWindow("5h", utilization, resetsAtIso, 300);
  }
  if (key === "seven_day") return usageWindow("7d", utilization, resetsAtIso, 10_080);
  return usageWindow(key.replace(/^seven_day_/, "7d "), utilization, resetsAtIso);
}

/**
 * Every numeric limits[] bucket is displayed, including future server-side
 * kinds. Older responses fall back to named utilization buckets when the
 * array yields none. Repeated display names retain their first reading. A
 * five-hour reading of zero for a bucket the plan does not have is left out
 * (`fiveHourIsInapplicable`).
 */
export function windowsFromClaudeUsage(usage: JsonRecord, options: ClaudeUsageOptions = {}): EngineLimitWindow[] {
  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  const liveWindows = limits.map((item) => windowFromLimit(item, usage, options)).filter((window) => window !== undefined);
  const windows = liveWindows.length > 0
    ? liveWindows
    : Object.entries(usage).map((entry) => windowFromNamedBucket(entry, usage, options)).filter((window) => window !== undefined);
  const seen = new Set<string>();
  return windows.filter((window) => {
    if (seen.has(window.name)) return false;
    seen.add(window.name);
    return true;
  });
}

/**
 * True when a CLI statusline snapshot's `rate_limits` shows the plan has no
 * five-hour limit: a weekly reading and no `five_hour` key at all. The CLI
 * writes these from the rate-limit headers of real requests, so the newest
 * snapshot settles it whatever its age; only a newer one can overturn it. Any
 * `five_hour` entry, even an empty or null one, means the plan has the limit.
 */
export function statuslineShowsNoFiveHour(rateLimits: unknown): boolean {
  return isRecord(rateLimits) && isRecord(rateLimits.seven_day) && !Object.hasOwn(rateLimits, "five_hour");
}
