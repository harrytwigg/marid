import type { OpencodeUsageLimitsConfig } from "./config-types.js";
import type { EngineLimitBucket, EngineLimitEngineSnapshot, EngineLimitWindow, HundredfoldConfig } from "./types.js";
import { baseSnapshot, isoFromSeconds, nowIso } from "./engine-limits-util.js";
import { initDb } from "./db.js";
import { readEngineSpend, type EngineSpendRow } from "../sessions/engine-spend.js";
import { declaredOpencodeAccounts, opencodeAccountByProvider } from "./opencode-accounts-config.js";

/**
 * opencode's limits, metered from hundredfold's own turn ledger.
 *
 * opencode publishes no account quota, and neither does the OpenCode Go
 * provider behind it — but Go's allowance is documented: each model has a
 * monthly limit in dollars of usage, metered over five hours (20% of it), seven
 * days (50%) and thirty days (100%). opencode reports every step's cost at the
 * provider's own prices, and every hundredfold turn's cost lands in the timestamped
 * `engine_spend` ledger. Sum the ledger over each window, divide by the
 * configured allowance, and opencode reads like any engine with windows —
 * which is what lets `recordExhaustedWindows` mark it exhausted with a real
 * reopening, instead of the 15-minute `degraded` an unexplained 429 earns.
 *
 * An estimate, and the snapshot says so (`status: "snapshot"`). It counts only
 * turns hundredfold ran: opencode used by hand outside hundredfold is invisible to it. The
 * windows are treated as trailing, which is exact for a rolling window and
 * conservative for one anchored at first use.
 */

interface WindowShape { name: string; minutes: number; share: number }

/** OpenCode Go's published windows, as shares of a model's monthly limit. */
export const OPENCODE_GO_WINDOWS: readonly WindowShape[] = [
  { name: "5h", minutes: 300, share: 0.2 },
  { name: "7d", minutes: 10_080, share: 0.5 },
  { name: "30d", minutes: 43_200, share: 1 },
];

const LONGEST_WINDOW_MS = Math.max(...OPENCODE_GO_WINDOWS.map((window) => window.minutes)) * 60_000;

function positiveLimit(table: Record<string, number> | undefined, key: string): number | undefined {
  if (!table || typeof table !== "object") return undefined;
  const value = table[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The monthly allowance that meters `model`, or undefined when none does. An
 *  exact key beats its provider's `provider/*` key; a non-positive or
 *  non-numeric value meters nothing rather than dividing by it. */
export function monthlyLimitFor(model: string, limits: OpencodeUsageLimitsConfig | undefined): number | undefined {
  const table = limits?.monthlyUsd;
  const slash = model.indexOf("/");
  const candidates = slash > 0 ? [model, `${model.slice(0, slash)}/*`] : [model];
  for (const key of candidates) {
    const value = positiveLimit(table, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The monthly allowance that meters `<provider>/<model>`, accounts included
 * (docs/design/opencode-accounts.md, "Metering and health"):
 *
 * 1. a declared account's own `usageLimits.monthlyUsd` for its provider: the
 *    exact model beats `*`;
 * 2. the engine-level `usageLimits` key naming the provider directly
 *    (`<provider>/<model>`, then `<provider>/*`), which still meters any
 *    provider, an account's included;
 * 3. an account that declares no limits of its own and has a `base`: the
 *    engine-level keys of its base, with the same exact-then-`*` order.
 *
 * Undefined meters nothing.
 */
export function meteredLimitFor(config: HundredfoldConfig, model: string): number | undefined {
  const engineLimits = config.engines.opencode?.usageLimits;
  const slash = model.indexOf("/");
  const account = slash > 0 ? opencodeAccountByProvider(config, model.slice(0, slash)) : undefined;
  if (!account) return monthlyLimitFor(model, engineLimits);
  const bare = model.slice(slash + 1);
  const own = positiveLimit(account.monthlyUsd, bare) ?? positiveLimit(account.monthlyUsd, "*");
  if (own !== undefined) return own;
  const direct = monthlyLimitFor(model, engineLimits);
  if (direct !== undefined || account.monthlyUsd !== undefined || account.base === undefined) return direct;
  return monthlyLimitFor(`${account.base}/${bare}`, engineLimits);
}

/** The providers' own model ids an account's limits name outright, so a model with no spend yet still shows its windows. */
function accountModels(config: HundredfoldConfig): string[] {
  return declaredOpencodeAccounts(config).flatMap((account) => {
    const named = [...(account.models ?? []), ...Object.keys(account.monthlyUsd ?? {}).filter((key) => key !== "*")];
    return account.monthlyUsd === undefined ? [] : named.map((model) => `${account.provider}/${model}`);
  });
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
  "OpenCode exposes no account quota endpoint, and no allowance is configured to meter hundredfold's own opencode spend against. "
  + "Set engines.opencode.usageLimits.monthlyUsd (or an account's usageLimits) to meter it (docs/engines-opencode.md).";

/** The ledger grouped by the model each row was charged to, with what the
 *  whole engine spent. Rows name the model the turn ran on, resolved when it
 *  was written; one with none (the engine was handed no model at all, so
 *  opencode picked its own) is charged to today's default as the best guess.
 *  The default always has a group, even an empty one, so an engine that has
 *  spent nothing yet still shows its windows at zero. */
function spendByModel(
  rows: readonly EngineSpendRow[],
  defaultModel: string | undefined,
  alsoShown: readonly string[] = [],
): { byModel: Map<string, EngineSpendRow[]>; costUsd: number } {
  const byModel = new Map<string, EngineSpendRow[]>(defaultModel ? [[defaultModel, []]] : []);
  for (const model of alsoShown) if (!byModel.has(model)) byModel.set(model, []);
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
function meteredBuckets(byModel: Map<string, EngineSpendRow[]>, config: HundredfoldConfig, nowMs: number): EngineLimitBucket[] {
  const buckets: EngineLimitBucket[] = [];
  for (const [model, rows] of [...byModel].sort(([a], [b]) => a.localeCompare(b))) {
    const monthlyUsd = meteredLimitFor(config, model);
    if (monthlyUsd === undefined) continue;
    buckets.push({ id: model, name: model, planType: `${money(monthlyUsd)}/month`, windows: modelWindows(rows, monthlyUsd, nowMs) });
  }
  return buckets;
}

/** Why the snapshot cannot speak for the engine, when it cannot. */
function unmeteredNote(available: boolean, defaultModel: string | undefined, defaultBucket: EngineLimitBucket | undefined): string | undefined {
  if (!available) return "opencode CLI is not installed.";
  if (defaultBucket) return undefined;
  return `The engine default model${defaultModel ? ` ${defaultModel}` : ""} matches no allowance, so no window is shown for it here. A spent window of any other metered model still marks that model's provider out.`;
}

/**
 * The opencode snapshot, or undefined when nothing is configured to meter — so
 * the caller keeps its plain "unsupported" answer for an unconfigured engine.
 *
 * `windows` are the engine default model's, for display: that is the model a
 * session with no pin runs on. Health is not fed from them: it is one record
 * per provider (`opencode/<provider>`), written from every bucket by
 * `recordMeteredExhaustion`. Every metered model, the default included, is a
 * bucket, so a pinned model's allowance is visible in `hundredfold limits` and the API.
 * (The Limits page renders top-level windows only.)
 */
export function collectOpencodeLimits(config: HundredfoldConfig, deps: OpencodeLimitsDeps = {}): EngineLimitEngineSnapshot | undefined {
  if (!meteringConfigured(config)) return undefined;
  const snap = baseSnapshot(config, "opencode");
  const nowMs = (deps.now ?? Date.now)();
  const readSpend = deps.readSpend ?? ((sinceMs: number) => readEngineSpend(initDb(), "opencode", sinceMs));
  return meteredSnapshot(snap, config, config.engines.opencode?.model ?? snap.defaultModel, readSpend(nowMs - LONGEST_WINDOW_MS), nowMs);
}

/** Whether the engine-level table or any account's own table meters something. */
export function meteringConfigured(config: HundredfoldConfig): boolean {
  const engineLimits = config.engines.opencode?.usageLimits?.monthlyUsd;
  if (engineLimits && Object.keys(engineLimits).length > 0) return true;
  return declaredOpencodeAccounts(config).some((account) => account.monthlyUsd !== undefined && Object.keys(account.monthlyUsd).length > 0);
}

function meteredSnapshot(
  snap: EngineLimitEngineSnapshot,
  config: HundredfoldConfig,
  defaultModel: string | undefined,
  rows: readonly EngineSpendRow[],
  nowMs: number,
): EngineLimitEngineSnapshot {
  const { byModel, costUsd } = spendByModel(rows, defaultModel, accountModels(config));
  const buckets = meteredBuckets(byModel, config, nowMs);
  const defaultBucket = buckets.find((bucket) => bucket.id === defaultModel);
  const note = unmeteredNote(snap.available, defaultModel, defaultBucket);
  return {
    ...snap,
    // No default-model bucket means nothing here can speak for the engine: say
    // so as `unsupported`, which the Limits page shows the reason for, rather
    // than as a snapshot with no windows that reads as healthy.
    status: snap.available ? (defaultBucket ? "snapshot" : "unsupported") : "unavailable",
    source: "hundredfold turn ledger (opencode-reported cost)",
    refreshedAt: nowIso(),
    ...(defaultBucket ? { accountPlan: `${defaultBucket.id} · ${defaultBucket.planType}` } : {}),
    windows: defaultBucket?.windows ?? [],
    buckets,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    ...(note ? { unsupportedReason: note } : {}),
  };
}
