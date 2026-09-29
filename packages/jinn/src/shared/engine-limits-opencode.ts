import type { OpencodeUsageLimitsConfig } from "./config-types.js";
import type { EngineLimitBucket, EngineLimitEngineSnapshot, EngineLimitWindow, JinnConfig } from "./types.js";
import { baseSnapshot, isoFromSeconds, nowIso } from "./engine-limits-util.js";
import { initDb } from "./db.js";
import { readEngineSpend, type EngineSpendRow } from "../sessions/engine-spend.js";

/**
 * opencode's limits, metered from jinn's own turn ledger.
 *
 * opencode publishes no account quota, and neither does the OpenCode Go
 * provider behind it — but Go's allowance is documented: each model has a
 * monthly limit in dollars of usage, metered over five hours (20% of it), seven
 * days (50%) and thirty days (100%). opencode reports every step's cost at the
 * provider's own prices, and every jinn turn's cost lands in the timestamped
 * `engine_spend` ledger. Sum the ledger over each window, divide by the
 * configured allowance, and opencode reads like any engine with windows —
 * which is what lets `recordExhaustedWindows` mark it exhausted with a real
 * reopening, instead of the 15-minute `degraded` an unexplained 429 earns.
 *
 * An estimate, and the snapshot says so (`status: "snapshot"`). It counts only
 * turns jinn ran: opencode used by hand outside jinn is invisible to it. The
 * windows are treated as trailing, which is exact for a rolling window and
 * conservative for one anchored at first use. A turn the opencode-rate-limit
 * plugin moved to another provider is charged to the model jinn asked for —
 * the plugin only moves a turn after that model refused, so the over-count
 * errs towards reading the allowance as spent, never as spare.
 */

interface WindowShape { name: string; minutes: number; share: number }

/** OpenCode Go's published windows, as shares of a model's monthly limit. */
export const OPENCODE_GO_WINDOWS: readonly WindowShape[] = [
  { name: "5h", minutes: 300, share: 0.2 },
  { name: "7d", minutes: 10_080, share: 0.5 },
  { name: "30d", minutes: 43_200, share: 1 },
];

const LONGEST_WINDOW_MS = Math.max(...OPENCODE_GO_WINDOWS.map((window) => window.minutes)) * 60_000;

/** The monthly allowance that meters `model`, or undefined when none does. An
 *  exact key beats its provider's `provider/*` key; a non-positive or
 *  non-numeric value meters nothing rather than dividing by it. */
export function monthlyLimitFor(model: string, limits: OpencodeUsageLimitsConfig | undefined): number | undefined {
  const table = limits?.monthlyUsd;
  if (!table || typeof table !== "object") return undefined;
  const slash = model.indexOf("/");
  const candidates = slash > 0 ? [model, `${model.slice(0, slash)}/*`] : [model];
  for (const key of candidates) {
    const value = table[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export interface MeteredWindow {
  usedUsd: number;
  /** Unrounded, so the caller decides how to show it. */
  usedPercent: number;
  /** Epoch ms at which the window drops back under its limit; present only
   *  while it is at or over it. */
  reopensAtMs?: number;
}

/**
 * One trailing window over `rows` (oldest first). While the window is spent,
 * the reopening is the moment enough of its oldest spend has aged out to bring
 * it back under the limit — not merely the moment the oldest row ages out,
 * which can leave it still over.
 */
export function meterWindow(rows: readonly EngineSpendRow[], windowMs: number, limitUsd: number, nowMs: number): MeteredWindow {
  const inWindow = rows.filter((row) => row.atMs > nowMs - windowMs && row.atMs <= nowMs);
  const usedUsd = inWindow.reduce((sum, row) => sum + row.cost, 0);
  const usedPercent = (usedUsd / limitUsd) * 100;
  if (usedUsd < limitUsd) return { usedUsd, usedPercent };
  let remaining = usedUsd;
  for (const row of inWindow) {
    remaining -= row.cost;
    if (remaining < limitUsd) return { usedUsd, usedPercent, reopensAtMs: row.atMs + windowMs };
  }
  return { usedUsd, usedPercent };
}

/** A window as the Limits snapshot carries it. The percentage is floored to a
 *  tenth, so it only reads 100 when the window really is spent — which is the
 *  one comparison `recordExhaustedWindows` makes. */
function limitWindow(shape: WindowShape, metered: MeteredWindow): EngineLimitWindow {
  const resetsAt = metered.reopensAtMs === undefined ? undefined : Math.ceil(metered.reopensAtMs / 1000);
  return {
    name: shape.name,
    usedPercent: Math.floor(metered.usedPercent * 10) / 10,
    windowDurationMins: shape.minutes,
    ...(resetsAt === undefined ? {} : { resetsAt, resetsAtIso: isoFromSeconds(resetsAt) }),
  };
}

/** Every Go window for one model's rows under its monthly limit. */
export function modelWindows(rows: readonly EngineSpendRow[], monthlyUsd: number, nowMs: number): EngineLimitWindow[] {
  return OPENCODE_GO_WINDOWS.map((shape) =>
    limitWindow(shape, meterWindow(rows, shape.minutes * 60_000, monthlyUsd * shape.share, nowMs)));
}

function money(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

export interface OpencodeLimitsDeps {
  /** The engine's spend since an instant; defaults to the gateway's ledger. */
  readSpend?: (sinceMs: number) => EngineSpendRow[];
  now?: () => number;
}

export const OPENCODE_UNMETERED_REASON =
  "OpenCode exposes no account quota endpoint, and no allowance is configured to meter jinn's own opencode spend against. "
  + "Set engines.opencode.usageLimits.monthlyUsd to meter it (docs/engines-opencode.md).";

/** The ledger grouped by the model each row was charged to, with what the
 *  whole engine spent. Rows name the model the turn ran on, resolved when it
 *  was written; one with none (the engine was handed no model at all, so
 *  opencode picked its own) is charged to today's default as the best guess.
 *  The default always has a group, even an empty one, so an engine that has
 *  spent nothing yet still shows its windows at zero. */
function spendByModel(rows: readonly EngineSpendRow[], defaultModel: string | undefined): { byModel: Map<string, EngineSpendRow[]>; costUsd: number } {
  const byModel = new Map<string, EngineSpendRow[]>(defaultModel ? [[defaultModel, []]] : []);
  let costUsd = 0;
  for (const row of rows) {
    costUsd += row.cost;
    const model = row.model ?? defaultModel;
    if (!model) continue;
    const group = byModel.get(model);
    if (group) group.push(row); else byModel.set(model, [row]);
  }
  return { byModel, costUsd };
}

/** One bucket per model an allowance meters, in model order. */
function meteredBuckets(byModel: Map<string, EngineSpendRow[]>, limits: OpencodeUsageLimitsConfig, nowMs: number): EngineLimitBucket[] {
  const buckets: EngineLimitBucket[] = [];
  for (const [model, rows] of [...byModel].sort(([a], [b]) => a.localeCompare(b))) {
    const monthlyUsd = monthlyLimitFor(model, limits);
    if (monthlyUsd === undefined) continue;
    buckets.push({ id: model, name: model, planType: `${money(monthlyUsd)}/month`, windows: modelWindows(rows, monthlyUsd, nowMs) });
  }
  return buckets;
}

/** Why the snapshot cannot speak for the engine, when it cannot. */
function unmeteredNote(available: boolean, defaultModel: string | undefined, defaultBucket: EngineLimitBucket | undefined): string | undefined {
  if (!available) return "opencode CLI is not installed.";
  if (defaultBucket) return undefined;
  return `The engine default model${defaultModel ? ` ${defaultModel}` : ""} matches no engines.opencode.usageLimits.monthlyUsd key, so no window can mark opencode out.`;
}

/**
 * The opencode snapshot, or undefined when nothing is configured to meter — so
 * the caller keeps its plain "unsupported" answer for an unconfigured engine.
 *
 * `windows` are the engine default model's: that is the model a session with no
 * pin runs on, and engine health — which the windows feed — is one record per
 * engine, not per model. Every metered model, the default included, is also a
 * bucket, so a pinned model's allowance is visible in `jinn limits` and the API
 * even though it cannot mark the whole engine out. (The Limits page renders
 * top-level windows only.)
 */
export function collectOpencodeLimits(config: JinnConfig, deps: OpencodeLimitsDeps = {}): EngineLimitEngineSnapshot | undefined {
  const limits = configuredLimits(config);
  if (!limits) return undefined;
  const snap = baseSnapshot(config, "opencode");
  const nowMs = (deps.now ?? Date.now)();
  const readSpend = deps.readSpend ?? ((sinceMs: number) => readEngineSpend(initDb(), "opencode", sinceMs));
  return meteredSnapshot(snap, config.engines.opencode?.model ?? snap.defaultModel, readSpend(nowMs - LONGEST_WINDOW_MS), limits, nowMs);
}

/** The allowance table, when there is one with anything in it. */
function configuredLimits(config: JinnConfig): OpencodeUsageLimitsConfig | undefined {
  const limits = config.engines.opencode?.usageLimits;
  return limits?.monthlyUsd && Object.keys(limits.monthlyUsd).length > 0 ? limits : undefined;
}

function meteredSnapshot(
  snap: EngineLimitEngineSnapshot,
  defaultModel: string | undefined,
  rows: readonly EngineSpendRow[],
  limits: OpencodeUsageLimitsConfig,
  nowMs: number,
): EngineLimitEngineSnapshot {
  const { byModel, costUsd } = spendByModel(rows, defaultModel);
  const buckets = meteredBuckets(byModel, limits, nowMs);
  const defaultBucket = buckets.find((bucket) => bucket.id === defaultModel);
  const note = unmeteredNote(snap.available, defaultModel, defaultBucket);
  return {
    ...snap,
    // No default-model bucket means nothing here can speak for the engine: say
    // so as `unsupported`, which the Limits page shows the reason for, rather
    // than as a snapshot with no windows that reads as healthy.
    status: snap.available ? (defaultBucket ? "snapshot" : "unsupported") : "unavailable",
    source: "jinn turn ledger (opencode-reported cost)",
    refreshedAt: nowIso(),
    ...(defaultBucket ? { accountPlan: `${defaultBucket.id} · ${defaultBucket.planType}` } : {}),
    windows: defaultBucket?.windows ?? [],
    buckets,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    ...(note ? { unsupportedReason: note } : {}),
  };
}
