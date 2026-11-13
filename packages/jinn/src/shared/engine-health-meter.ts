import { isSpent, METERED_WINDOW_REASON, readStore, type EngineHealth } from "./engine-health-store.js";
import { recordEngineUnavailable } from "./engine-health.js";
import type { EngineLimitBucket, EngineLimitWindow } from "./types.js";

/**
 * What the opencode usage meter writes to engine health.
 *
 * The meter reads jinn's own turn ledger, so it can only speak for one
 * provider's allowance, never for the engine: a spent window of ANY metered
 * model records `opencode/<provider>` exhausted, stamped with that model, until
 * the latest reopening among that provider's spent windows. It never writes the
 * engine-wide `opencode` key, which would mark every provider out because one
 * was.
 *
 * The ledger does not see the provider's own meter, so a refusal the provider
 * itself answered with outranks it (see {@link holdsAgainstMeter}).
 */

export { METERED_WINDOW_REASON };

/** The key a provider's meter-written record lives under. */
export function providerHealthKey(provider: string): string {
  return `opencode/${provider}`;
}

interface SpentWindow {
  model: string;
  window: EngineLimitWindow;
  reopensAtMs: number;
}

/** The provider a bucket's `<provider>/<model>` id names; none for a model with no provider, which belongs to no `opencode/<provider>` key (the meter never writes the engine's own). */
function providerOfBucket(bucket: EngineLimitBucket): string | undefined {
  const slash = bucket.id.indexOf("/");
  return slash > 0 ? bucket.id.slice(0, slash) : undefined;
}

/** The bucket's spent window that reopens last, if it has one still closed at `nowMs`. */
function lastReopening(bucket: EngineLimitBucket, nowMs: number): SpentWindow | undefined {
  let latest: SpentWindow | undefined;
  for (const window of bucket.windows ?? []) {
    const reopensAtMs = (window.resetsAt ?? 0) * 1000;
    if ((window.usedPercent ?? 0) < 100 || reopensAtMs <= nowMs) continue;
    if (reopensAtMs > (latest?.reopensAtMs ?? 0)) latest = { model: bucket.id, window, reopensAtMs };
  }
  return latest;
}

/** Every provider's binding spent window: the latest reopening across all its metered models and windows. */
function bindingByProvider(buckets: readonly EngineLimitBucket[], nowMs: number): Map<string, SpentWindow> {
  const binding = new Map<string, SpentWindow>();
  for (const bucket of buckets) {
    const provider = providerOfBucket(bucket);
    const spent = provider === undefined ? undefined : lastReopening(bucket, nowMs);
    if (provider !== undefined && spent && spent.reopensAtMs > (binding.get(provider)?.reopensAtMs ?? 0)) binding.set(provider, spent);
  }
  return binding;
}

/**
 * Whether the record already held outranks what the meter would write.
 *
 * A record the meter wrote itself is refreshed freely: the ledger is the truth
 * it was written from. Anything else live and `exhausted` is a refusal the
 * provider gave, and it stays unless it is quota-derived and ends sooner than
 * the meter's reopening, which the longer claim may replace. A refusal that
 * does not say what it was is kept: unknown is never shortened.
 */
function holdsAgainstMeter(record: EngineHealth | undefined, reopensAtMs: number, now: Date): boolean {
  if (!record || record.state !== "exhausted" || isSpent(record, now)) return false;
  const failureClass = record.failureClass;
  if (record.reason === METERED_WINDOW_REASON && failureClass === undefined) return false;
  if (failureClass !== "quota" || record.until === undefined) return true;
  return Date.parse(record.until) >= reopensAtMs;
}

/** Write what the buckets' spent windows say: one `opencode/<provider>` record per provider with one. */
export function recordMeteredExhaustion(buckets: readonly EngineLimitBucket[] | undefined, now: Date = new Date()): void {
  const standing = readStore();
  for (const [provider, spent] of bindingByProvider(buckets ?? [], now.getTime())) {
    const key = providerHealthKey(provider);
    if (holdsAgainstMeter(standing[key], spent.reopensAtMs, now)) continue;
    recordEngineUnavailable(key, METERED_WINDOW_REASON, spent.window.resetsAt, now, { window: spent.window.name, model: spent.model });
  }
}
