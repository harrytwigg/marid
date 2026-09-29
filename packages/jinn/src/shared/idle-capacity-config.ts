/**
 * Idle-capacity auto-start: the policy — its shape, its defaults,
 * how config.yaml's `gateway.idleCapacity` resolves onto it, and the shape
 * check that refuses a malformed block at config load. The decision that
 * reads a policy lives in idle-capacity.ts.
 */

export type IdleCapacityTier = "overnight" | "daytime" | "interactive";

export interface IdleCapacityWindowPolicy {
  /** Hold whenever this window's used percentage is above this. What is left
   *  above the ceiling is the operator's own headroom. */
  maxUsedPercent: number;
  /** The window only counts as "about to lapse" once its reset is within this
   *  many minutes. Outside it, the unused share may still be used later. */
  lookaheadMinutes: number;
}

export interface IdleCapacityTierPolicy {
  /** A tier switched off never starts anything. */
  enabled: boolean;
  fiveHour: IdleCapacityWindowPolicy;
  sevenDay: IdleCapacityWindowPolicy;
  /** Todos started per five-hour window, counted by that window's reset time.
   *  A second guard on top of the ceilings, for the case where a started Todo
   *  has not yet shown up in the account's reading. */
  maxDispatchesPerWindow: number;
  /** Hold while this many sessions (or more) already hold engine capacity —
   *  mid-turn, queued, or parked on a gate. Capacity is not idle while the
   *  operator or another employee is using it. */
  maxActiveSessions: number;
}

export interface IdleCapacityPolicy {
  enabled: boolean;
  /** How often the gateway re-reads the limits and reconsiders. */
  intervalMinutes: number;
  /** IANA zone the quiet hours are read in. */
  timezone: string;
  /** The overnight tier's hours, `HH:MM` local to `timezone`; may wrap midnight. */
  quietHours: { start: string; end: string };
  /** How the operator is recognised as live (see `docs/idle-capacity.md`). */
  operatorActivity: {
    /** The operator counts as live for this long after the last sign of them. */
    idleMinutes: number;
    /** Five-hour usage rising by at least this many points between two
     *  readings, while no Jinn session ran, is usage the system did not spend
     *  — so it is the operator's. */
    usageDeltaPercent: number;
  };
  tiers: Record<IdleCapacityTier, IdleCapacityTierPolicy>;
  /** When set, only backlog Todos carrying this label are eligible (opt-in).
   *  Unset means every backlog Todo that has not opted out. */
  requireLabel: string | null;
}

/** The label a backlog Todo carries to keep every automatic start away from it
 * (uses the same one for the assignment auto-start). */
export const IDLE_CAPACITY_OPT_OUT_LABEL = "no-auto-start";

export const IDLE_CAPACITY_DEFAULTS: IdleCapacityPolicy = {
  enabled: false,
  intervalMinutes: 10,
  timezone: "Europe/London",
  quietHours: { start: "01:00", end: "06:00" },
  operatorActivity: { idleMinutes: 30, usageDeltaPercent: 2 },
  tiers: {
    // Spend deep: the window resets unused otherwise. The 15% left above the
    // ceiling is the hard floor — enough that a start here does not, by
    // itself, push something else running concurrently into a fallback.
    overnight: {
      enabled: true,
      fiveHour: { maxUsedPercent: 85, lookaheadMinutes: 300 },
      sevenDay: { maxUsedPercent: 85, lookaheadMinutes: 24 * 60 },
      maxDispatchesPerWindow: 3,
      maxActiveSessions: 1,
    },
    // Moderate: leave real headroom for an interactive session later in the day.
    daytime: {
      enabled: true,
      fiveHour: { maxUsedPercent: 50, lookaheadMinutes: 120 },
      sevenDay: { maxUsedPercent: 75, lookaheadMinutes: 24 * 60 },
      maxDispatchesPerWindow: 2,
      maxActiveSessions: 1,
    },
    // The operator is live: barely touch it. One start, only in the last half
    // hour of a window that is almost untouched.
    interactive: {
      enabled: true,
      fiveHour: { maxUsedPercent: 20, lookaheadMinutes: 30 },
      sevenDay: { maxUsedPercent: 60, lookaheadMinutes: 24 * 60 },
      maxDispatchesPerWindow: 1,
      maxActiveSessions: 1,
    },
  },
  requireLabel: null,
};

/** The raw `gateway.idleCapacity` mapping from config.yaml, before defaults. */
export interface IdleCapacityConfig {
  enabled?: boolean;
  intervalMinutes?: number;
  timezone?: string;
  quietHours?: Partial<IdleCapacityPolicy["quietHours"]>;
  operatorActivity?: Partial<IdleCapacityPolicy["operatorActivity"]>;
  tiers?: Partial<Record<IdleCapacityTier, IdleCapacityTierConfig>>;
  requireLabel?: string | null;
}

export interface IdleCapacityTierConfig {
  enabled?: boolean;
  fiveHour?: Partial<IdleCapacityWindowPolicy>;
  sevenDay?: Partial<IdleCapacityWindowPolicy>;
  maxDispatchesPerWindow?: number;
  maxActiveSessions?: number;
}

export const IDLE_CAPACITY_TIERS: readonly IdleCapacityTier[] = ["overnight", "daytime", "interactive"];

/** Drop the undefined keys so a spread over the defaults keeps them. */
function defined<T extends object>(raw: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function resolveTier(base: IdleCapacityTierPolicy, raw: IdleCapacityTierConfig | undefined): IdleCapacityTierPolicy {
  return {
    ...base,
    ...defined(raw),
    fiveHour: { ...base.fiveHour, ...defined(raw?.fiveHour) },
    sevenDay: { ...base.sevenDay, ...defined(raw?.sevenDay) },
  };
}

export function resolveIdleCapacityPolicy(raw: IdleCapacityConfig | undefined): IdleCapacityPolicy {
  const d = IDLE_CAPACITY_DEFAULTS;
  return {
    ...d,
    ...defined(raw),
    quietHours: { ...d.quietHours, ...defined(raw?.quietHours) },
    operatorActivity: { ...d.operatorActivity, ...defined(raw?.operatorActivity) },
    tiers: Object.fromEntries(
      IDLE_CAPACITY_TIERS.map((tier) => [tier, resolveTier(d.tiers[tier], raw?.tiers?.[tier])]),
    ) as IdleCapacityPolicy["tiers"],
  };
}

// ── Config shape checks ──────────────────────────────────────────────────────

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percentProblem(path: string, value: unknown, min = 0): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > 100) {
    return `${path} must be a number between ${min} and 100 (got ${JSON.stringify(value)})`;
  }
  return null;
}

function positiveIntegerProblem(path: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < 1) {
    return `${path} must be a whole number of at least 1 (got ${JSON.stringify(value)})`;
  }
  return null;
}

function booleanProblem(path: string, value: unknown): string | null {
  if (value === undefined || typeof value === "boolean") return null;
  return `${path} must be a boolean (got ${typeof value})`;
}

const present = (problems: Array<string | null>): string[] => problems.filter((problem): problem is string => problem !== null);

function windowProblems(path: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return [`${path} must be a mapping`];
  return present([
    percentProblem(`${path}.maxUsedPercent`, value.maxUsedPercent),
    positiveIntegerProblem(`${path}.lookaheadMinutes`, value.lookaheadMinutes),
  ]);
}

function tierProblems(path: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return [`${path} must be a mapping`];
  return [
    ...present([
      booleanProblem(`${path}.enabled`, value.enabled),
      positiveIntegerProblem(`${path}.maxDispatchesPerWindow`, value.maxDispatchesPerWindow),
      positiveIntegerProblem(`${path}.maxActiveSessions`, value.maxActiveSessions),
    ]),
    ...windowProblems(`${path}.fiveHour`, value.fiveHour),
    ...windowProblems(`${path}.sevenDay`, value.sevenDay),
  ];
}

function tiersProblems(path: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return [`${path} must be a mapping of overnight, daytime and interactive`];
  const unknown = Object.keys(value).filter((key) => !IDLE_CAPACITY_TIERS.includes(key as IdleCapacityTier));
  return [
    ...(unknown.length > 0 ? [`${path} has unknown tier${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (tiers are ${IDLE_CAPACITY_TIERS.join(", ")})`] : []),
    ...IDLE_CAPACITY_TIERS.flatMap((tier) => tierProblems(`${path}.${tier}`, value[tier])),
  ];
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function quietHoursProblems(path: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return [`${path} must be a mapping with start and end`];
  return (["start", "end"] as const)
    .filter((key) => value[key] !== undefined && (typeof value[key] !== "string" || !HH_MM.test(value[key] as string)))
    .map((key) => `${path}.${key} must be a time of day as HH:MM (got ${JSON.stringify(value[key])})`);
}

function timezoneProblem(path: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) return `${path} must be an IANA time zone name`;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return null;
  } catch {
    return `${path} is not a time zone this runtime knows (got ${JSON.stringify(value)})`;
  }
}

function operatorActivityProblems(path: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return [`${path} must be a mapping`];
  return present([
    positiveIntegerProblem(`${path}.idleMinutes`, value.idleMinutes),
    // Floored at 1: a delta of 0 would make every unchanged reading a
    // sighting and pin the loop to the interactive tier for good.
    percentProblem(`${path}.usageDeltaPercent`, value.usageDeltaPercent, 1),
  ]);
}

/** The same rule `normalizeLabelName` (work-items/labels.ts) enforces — at
 *  least one letter or digit — checked here so a label the normaliser would
 *  throw on is refused when config loads, not on every tick after. */
function labelProblem(path: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/[a-z0-9]/i.test(value)) {
    return `${path} must be a label name with at least one letter or digit, or null`;
  }
  return null;
}

/** Shape-check `gateway.idleCapacity`. Unset is valid (the feature is off). */
export function idleCapacityProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return ["gateway.idleCapacity must be a mapping"];
  const p = "gateway.idleCapacity";
  return [
    ...present([
      booleanProblem(`${p}.enabled`, value.enabled),
      positiveIntegerProblem(`${p}.intervalMinutes`, value.intervalMinutes),
      timezoneProblem(`${p}.timezone`, value.timezone),
      labelProblem(`${p}.requireLabel`, value.requireLabel),
    ]),
    ...quietHoursProblems(`${p}.quietHours`, value.quietHours),
    ...operatorActivityProblems(`${p}.operatorActivity`, value.operatorActivity),
    ...tiersProblems(`${p}.tiers`, value.tiers),
  ];
}
