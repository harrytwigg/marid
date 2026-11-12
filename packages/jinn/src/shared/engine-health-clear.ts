import { isSpent, readStore, writeStore, type EngineHealth, type EngineHealthReading } from "./engine-health-store.js";
import type { EngineLimitWindow } from "./types.js";

/**
 * Ending an engine-health record early, on evidence that the limit it records
 * has lifted.
 *
 * A record states when a limit reopens, and a provider can lift a limit sooner
 * (an early reset, an offered reset the operator took). Left alone the record
 * keeps the account out until its stated reopening. A clear replaces it with a
 * positive `ok` record carrying `clearedAt`: a record that merely lapsed reads
 * back `ok` without one, and only a positive clear may end a held stand-in early.
 *
 * Only an account-wide record (no `host`) in an unspent `exhausted` or
 * `degraded` state is ever cleared, and only by evidence newer than the record:
 * a reading taken, or a turn begun, after the limit was observed. A record about
 * one machine's login is the auth watch's to write.
 */

/** The record this evidence may clear, or undefined when it may not. */
function clearable(store: EngineHealthReading, key: string, now: Date): EngineHealth | undefined {
  const record = store[key];
  if (!record || record.state === "ok" || record.host !== undefined || isSpent(record, now)) return undefined;
  return record;
}

/** Whether `evidenceMs` (a reading's time, a turn's start) is strictly newer than the observation the record rests on. */
function newerThanRecord(record: EngineHealth, evidenceMs: number): boolean {
  const observed = record.observedAt === undefined ? NaN : Date.parse(record.observedAt);
  return Number.isFinite(observed) && Number.isFinite(evidenceMs) && evidenceMs > observed;
}

function clearRecord(store: EngineHealthReading, key: string, reason: string, now: Date): void {
  const stamp = now.toISOString();
  writeStore({ ...store, [key]: { state: "ok", clearedAt: stamp, observedAt: stamp, reason } });
}

/** Whether a reading shows headroom on every window, and still shows the window the record names. */
function showsHeadroom(record: EngineHealth, windows: readonly EngineLimitWindow[]): boolean {
  if (windows.length === 0) return false;
  if (!windows.every((window) => typeof window.usedPercent === "number" && window.usedPercent < 100)) return false;
  return record.window === undefined || windows.some((window) => window.name === record.window);
}

/**
 * Clear `key` when a usage reading taken after the limit was observed shows every
 * window under 100% (and the window the record names among them). One spent
 * window, or a reading older than the record, clears nothing.
 */
export function clearContradictedHealth(
  key: string,
  windows: readonly EngineLimitWindow[] | undefined,
  readAtMs: number,
  now: Date = new Date(),
): void {
  const store = readStore();
  const record = clearable(store, key, now);
  if (!record || !newerThanRecord(record, readAtMs) || !showsHeadroom(record, windows ?? [])) return;
  clearRecord(store, key, "usage reading shows headroom", now);
}

/** A Claude account's windows that every model's turns count against (its per-model buckets are named `7d <model>`). */
const CLAUDE_ACCOUNT_WINDOWS: readonly string[] = ["5h", "7d"];
/** A Claude account key: the default login, a local profile (`claude:<key>`) or a remote login (`claude@…`). */
const CLAUDE_ACCOUNT_KEY = /^claude($|[:@])/;

/**
 * Whether a turn served on `servedModel` contradicts the limit the record holds.
 * The newest limit a turn hit stamps its model, and the bucket may be that model's
 * own, so only a turn on that model counts. Otherwise a Claude account's spent
 * account-wide window does, whatever the model; a window scoped to one model, or
 * any other engine's (whose readings do not say which windows its models share),
 * is left to readings. A record naming neither came from a turn on the CLI default:
 * only a turn on the default counts, since an unnamed default may not be the model served.
 */
function servedContradicts(key: string, record: EngineHealth, servedModel: string | undefined): boolean {
  // A turn the provider served says its key works, and one on the model says the model is enabled. (The key is the provider's or the model's, as written.)
  if (record.failureClass === "auth" || record.failureClass === "model-access") return true;
  if (record.model !== undefined) return record.model === servedModel;
  if (record.window !== undefined) return CLAUDE_ACCOUNT_KEY.test(key) && CLAUDE_ACCOUNT_WINDOWS.includes(record.window);
  return servedModel === undefined;
}

/**
 * Clear `key` when a turn that began after the limit was observed was served (a
 * turn that started before someone else observed the limit proves nothing about
 * it) and the turn's model says something about the limit held: see {@link servedContradicts}.
 */
export function recordEngineServed(key: string, turnStartedAtMs: number, servedModel: string | undefined, now: Date = new Date()): void {
  const store = readStore();
  const record = clearable(store, key, now);
  if (!record || !newerThanRecord(record, turnStartedAtMs) || !servedContradicts(key, record, servedModel)) return;
  clearRecord(store, key, "a turn was served", now);
}

/** Write a clear over `key`'s record whatever it holds, for the operator. Returns what it replaced; a key with no record is left alone (a mistyped key must not leave a stray record behind). */
export function clearEngineHealthByOperator(key: string, now: Date = new Date()): EngineHealth | undefined {
  const store = readStore();
  const replaced = store[key];
  if (replaced) clearRecord(store, key, "cleared by the operator", now);
  return replaced;
}
