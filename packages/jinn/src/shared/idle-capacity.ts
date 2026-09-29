import type { EngineLimitEngineSnapshot, EngineLimitWindow } from "./types.js";
import type {
  IdleCapacityPolicy,
  IdleCapacityTier,
  IdleCapacityTierPolicy,
  IdleCapacityWindowPolicy,
} from "./idle-capacity-config.js";
export * from "./idle-capacity-config.js";

/**
 * Idle-capacity auto-start: the decision, kept pure.
 *
 * A Claude subscription meters two rolling windows — five hours and seven days
 * — and whatever is unused when a window resets is simply gone. This module
 * decides, from one reading of the account's real limits (the same collector
 * the Limits page uses), whether there is capacity about to lapse that backlog
 * work could consume WITHOUT crowding the operator's own interactive use.
 *
 * How aggressive that is depends on the situation, in three tiers the operator
 * set out in the auto-start spec: overnight with nobody around (spend deep, keep only a
 * hard floor), daytime with no interactive session (moderate, leave real
 * headroom), and the operator live (back off almost entirely). Which tier
 * applies is decided in `selectTier`; what each tier permits is its own
 * `IdleCapacityTierPolicy`, and every number in it is configurable.
 *
 * Everything that touches the clock, the ledger or a session lives in
 * gateway/idle-capacity.ts. This file only turns a snapshot and a policy into a
 * verdict with a reason attached, so the reason can be tested and, when the
 * gateway acts on it, written on the Todo it started.
 *
 * What the ceilings are — and are not. A ceiling is a gate on STARTING: the
 * loop never starts work while a window is above it, and it re-reads the
 * account before every start. It is not a bound on consumption: once a Todo
 * is started, its session runs to completion, and a long session can carry a
 * window past the ceiling and into the next one. The residual risk is stated
 * in docs/idle-capacity.md so the ceilings can be set with it in mind. The
 * defaults err on the side of doing nothing: the feature is off unless
 * `gateway.idleCapacity.enabled` is true, and a reading that is missing,
 * stale, unreadable or names no reset is a reason to hold, never a reason to go.
 */

// ── Tier selection ───────────────────────────────────────────────────────────

/** Minutes past local midnight in `timezone` at `nowMs`. */
export function localMinuteOfDay(nowMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(nowMs));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
}

function minuteOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Whether `nowMs` falls in the quiet hours. `[start, end)`; a range that
 *  wraps midnight (say 22:00–06:00) is the two half-ranges either side of it. */
export function isQuietHour(nowMs: number, policy: IdleCapacityPolicy): boolean {
  const now = localMinuteOfDay(nowMs, policy.timezone);
  const start = minuteOf(policy.quietHours.start);
  const end = minuteOf(policy.quietHours.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export interface TierInput {
  nowMs: number;
  /** The operator has shown signs of life within `operatorActivity.idleMinutes`. */
  operatorActive: boolean;
}

/** The operator being live outranks the clock: an interactive session at 03:00
 *  is still an interactive session. */
export function selectTier(input: TierInput, policy: IdleCapacityPolicy): IdleCapacityTier {
  if (input.operatorActive) return "interactive";
  return isQuietHour(input.nowMs, policy) ? "overnight" : "daytime";
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export interface IdleCapacityWindowReading {
  name: string;
  usedPercent: number;
  /** The reset instant, unix seconds — the window's identity, since every
   *  reading of the same window names the same reset. */
  resetsAt: number;
  /** Minutes until the window resets. */
  minutesToReset: number;
}

export type IdleCapacityVerdict =
  | { act: true; tier: IdleCapacityTier; trigger: "5h" | "7d"; reason: string; fiveHour: IdleCapacityWindowReading; weekly: IdleCapacityWindowReading[] }
  | { act: false; tier: IdleCapacityTier; reason: string; fiveHour?: IdleCapacityWindowReading; weekly: IdleCapacityWindowReading[] };

/** A window as the verdict reads it, or undefined when it carries no usable
 *  reading: no percentage, no reset, or a reset already in the past. A past
 *  reset is not "0 minutes to go" — it is a window that no longer exists,
 *  which the CLI statusline snapshot can still name for up to half an hour
 *  after it rolled. */
function reading(window: EngineLimitWindow, nowMs: number): IdleCapacityWindowReading | undefined {
  if (window.usedPercent === undefined || window.resetsAt === undefined) return undefined;
  const msToReset = window.resetsAt * 1000 - nowMs;
  if (msToReset <= 0) return undefined;
  return { name: window.name, usedPercent: window.usedPercent, resetsAt: window.resetsAt, minutesToReset: Math.round(msToReset / 60_000) };
}

function lapsing(window: IdleCapacityWindowReading, policy: IdleCapacityWindowPolicy): boolean {
  return window.minutesToReset <= policy.lookaheadMinutes;
}

function describe(window: IdleCapacityWindowReading): string {
  return `${window.name} ${window.usedPercent}% used, resets in ${formatMinutes(window.minutesToReset)}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
}

/** The reading itself, before any policy is applied: undefined when it is
 *  usable, otherwise why it is not. */
function readingProblem(snapshot: EngineLimitEngineSnapshot): string | undefined {
  if (snapshot.status !== "live" && snapshot.status !== "snapshot") {
    return `no usable Claude limits reading (status ${snapshot.status})`;
  }
  if (snapshot.stale) return "the Claude limits reading is stale";
  return undefined;
}

/** Which window, if any, sits above its ceiling. */
function ceilingProblem(
  fiveHour: IdleCapacityWindowReading,
  weekly: IdleCapacityWindowReading[],
  tier: IdleCapacityTierPolicy,
): string | undefined {
  if (fiveHour.usedPercent > tier.fiveHour.maxUsedPercent) {
    return `${describe(fiveHour)} — above the ${tier.fiveHour.maxUsedPercent}% five-hour ceiling`;
  }
  const overWeekly = weekly.find((window) => window.usedPercent > tier.sevenDay.maxUsedPercent);
  return overWeekly ? `${describe(overWeekly)} — above the ${tier.sevenDay.maxUsedPercent}% weekly ceiling` : undefined;
}

interface UsableWindows { fiveHour: IdleCapacityWindowReading; allModels: IdleCapacityWindowReading; weekly: IdleCapacityWindowReading[] }

/** The five-hour and weekly windows the verdict needs, or the hold reason
 *  when the reading lacks one. Both must be present with a reset still ahead. */
function usableWindows(
  snapshot: EngineLimitEngineSnapshot,
  nowMs: number,
): { ok: true; windows: UsableWindows } | { ok: false; reason: string; fiveHour?: IdleCapacityWindowReading; weekly: IdleCapacityWindowReading[] } {
  const windows = (snapshot.windows ?? []).map((window) => reading(window, nowMs))
    .filter((window): window is IdleCapacityWindowReading => window !== undefined);
  const fiveHour = windows.find((window) => window.name === "5h");
  const weekly = windows.filter((window) => window.name === "7d" || window.name.startsWith("7d "));
  const allModels = weekly.find((window) => window.name === "7d");
  if (!fiveHour) return { ok: false, reason: "the reading carries no five-hour window with a reset still ahead", weekly };
  if (!allModels) return { ok: false, reason: "the reading carries no weekly window with a reset still ahead", fiveHour, weekly };
  return { ok: true, windows: { fiveHour, allModels, weekly } };
}

/** The five-hour window as the verdict would read it, for the caller that
 *  needs it before a tier is chosen (the operator-activity delta). */
export function fiveHourReading(snapshot: EngineLimitEngineSnapshot, nowMs = Date.now()): IdleCapacityWindowReading | undefined {
  if (readingProblem(snapshot)) return undefined;
  const usable = usableWindows(snapshot, nowMs);
  return usable.ok ? usable.windows.fiveHour : usable.fiveHour;
}

/**
 * Is there Claude capacity about to lapse that backlog work could use, under
 * the tier that applies right now?
 *
 * Acts on one of two triggers, and only ever within the tier's ceilings:
 *   - the five-hour window is about to reset with its used share at or below
 *     the five-hour ceiling, or
 *   - the seven-day window is about to reset with its used share at or below
 *     the weekly ceiling — the five-hour ceiling still applies, because that is
 *     the operator's interactive headroom whatever the week looks like.
 * Both the five-hour and the all-model weekly window must be present with a
 * usable reset, or the verdict is hold. Every weekly bucket the account
 * reports (the all-model one and any per-model one) must sit at or below the
 * weekly ceiling: a Todo started now will most likely run on exactly the
 * model a scoped bucket meters.
 */
export function evaluateIdleCapacity(
  snapshot: EngineLimitEngineSnapshot,
  tier: IdleCapacityTier,
  policy: IdleCapacityPolicy,
  nowMs = Date.now(),
): IdleCapacityVerdict {
  const rules = policy.tiers[tier];
  if (!rules.enabled) return { act: false, tier, reason: `the ${tier} tier is switched off`, weekly: [] };
  const unusable = readingProblem(snapshot);
  if (unusable) return { act: false, tier, reason: unusable, weekly: [] };

  const usable = usableWindows(snapshot, nowMs);
  if (!usable.ok) return { act: false, tier, reason: usable.reason, ...(usable.fiveHour ? { fiveHour: usable.fiveHour } : {}), weekly: usable.weekly };
  const { fiveHour, allModels, weekly } = usable.windows;

  const overCeiling = ceilingProblem(fiveHour, weekly, rules);
  if (overCeiling) return { act: false, tier, reason: overCeiling, fiveHour, weekly };

  const summary = [fiveHour, ...weekly].map(describe).join("; ");
  if (lapsing(fiveHour, rules.fiveHour)) {
    return { act: true, tier, trigger: "5h", reason: `${tier} tier, five-hour window about to lapse: ${summary}`, fiveHour, weekly };
  }
  if (lapsing(allModels, rules.sevenDay)) {
    return { act: true, tier, trigger: "7d", reason: `${tier} tier, weekly window about to lapse: ${summary}`, fiveHour, weekly };
  }
  return {
    act: false,
    tier,
    reason: `${tier} tier, no window within its lookahead (5h: ${rules.fiveHour.lookaheadMinutes} min, 7d: ${rules.sevenDay.lookaheadMinutes} min): ${summary}`,
    fiveHour, weekly,
  };
}
