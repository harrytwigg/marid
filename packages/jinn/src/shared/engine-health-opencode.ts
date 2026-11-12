import { isBillingFailureMessage } from "./engine-failure.js";
import { recheckFrom } from "./engine-health.js";
import { readStore, writeStore, isSpent, type EngineHealth } from "./engine-health-store.js";
import { recordEngineServed } from "./engine-health-clear.js";
import { isRateLimitMessage } from "./rateLimit.js";
import type { JinnConfig } from "./config-types.js";
import { classifyOpencodeFailure, type OpencodeFailure } from "./opencode-failure.js";
import {
  isOpencodeSubscriptionProvider,
  opencodeCredentialFingerprint,
  opencodeReprobeMs,
  opencodeModelHealthKey,
  providerOfOpencodeHealthKey,
  UNFINGERPRINTED_AUTH_HOLD_MS,
} from "./opencode-subscription.js";

/**
 * What a failed opencode provider call is held against.
 *
 * - A spent allowance (402, or a 429 window) holds the PROVIDER out until it
 *   reopens: the reset it stated, else the re-probe interval. Without this a
 *   dead subscription is the first link of every chain on every turn.
 * - A dead key (401) holds the PROVIDER out until the credential changes; one
 *   whose credential cannot be read is held for a day, so a wrong verdict heals.
 * - A model the account cannot use (403, region) holds only that (provider,
 *   model), so the provider's other models keep serving.
 *
 * A pay-as-you-go provider's 402 is not handled here: its balance does not
 * reopen on a clock, so it keeps the billing handling (`handled: false`).
 */

export interface OpencodeHealthWrite {
  /** The provider's key (`opencode/<provider>`), as `linkHealthKey` gives it. */
  healthKey: string;
  /** The model the failed turn ran on, as `provider/model`. */
  model?: string;
  /** The failed turn's error text. */
  error: string | undefined;
  /** When the failure stated the window reopens, in unix seconds. */
  resetsAt?: number;
  config: Pick<JinnConfig, "engines"> | undefined;
  /** The machine the turn ran on, when it is not this one. Its key, allowance and model access are its own: the record
   *  is about that host (and so is read by that host's sessions only), and this machine cannot read its credential. */
  host?: string;
  now?: Date;
}

/** The failure the error reports. One with no `provider.*` type still reads as a spent allowance on a subscription provider: its prose, or a reset it stated, says so. */
function failureOf(write: OpencodeHealthWrite, subscription: boolean): OpencodeFailure | undefined {
  const structured = classifyOpencodeFailure(write.error);
  if (structured || !subscription) return structured;
  if (isBillingFailureMessage(write.error)) return { kind: "quota" };
  return write.resetsAt !== undefined || isRateLimitMessage(write.error) ? { kind: "usage-limit" } : undefined;
}

function liveUntilMs(record: EngineHealth | undefined, now: Date): number | undefined {
  if (record?.state !== "exhausted" || isSpent(record, now) || record.until === undefined) return undefined;
  const until = Date.parse(record.until);
  return Number.isFinite(until) ? until : undefined;
}

/** Store the record, stamped with the host it is about. One machine's observation never displaces a standing account-wide one. */
function put(key: string, record: EngineHealth, host: string | undefined, now: Date): void {
  const store = readStore();
  const standing = store[key];
  if (host !== undefined && standing?.state === "exhausted" && standing.host === undefined && !isSpent(standing, now)) return;
  writeStore({ ...store, [key]: { ...record, ...(host === undefined ? {} : { host }) } });
}

function holdModel(write: OpencodeHealthWrite, provider: string, now: Date, observed: Pick<EngineHealth, "reason" | "observedAt">): boolean {
  const key = opencodeModelHealthKey(write.model);
  if (key === undefined) return false;
  put(key, { state: "exhausted", until: new Date(now.getTime() + opencodeReprobeMs(provider, write.config)).toISOString(), failureClass: "model-access", ...observed }, write.host, now);
  return true;
}

function holdSignedOut(write: OpencodeHealthWrite, provider: string, now: Date, observed: Pick<EngineHealth, "reason" | "observedAt">): void {
  const fingerprint = write.host === undefined ? opencodeCredentialFingerprint(provider, write.config) : undefined;
  put(write.healthKey, {
    state: "exhausted",
    failureClass: "auth",
    ...(fingerprint === undefined ? { until: new Date(now.getTime() + UNFINGERPRINTED_AUTH_HOLD_MS).toISOString() } : { credentialFingerprint: fingerprint }),
    ...observed,
  }, write.host, now);
}

function holdSpentAllowance(write: OpencodeHealthWrite, provider: string, now: Date, observed: Pick<EngineHealth, "reason" | "observedAt">): void {
  const stated = write.resetsAt !== undefined && Number.isFinite(write.resetsAt) ? write.resetsAt * 1000 : undefined;
  // A standing hold is kept only when it is about the same machine: another host's says nothing about this one's allowance.
  const record = readStore()[write.healthKey];
  const standing = record?.host === write.host ? liveUntilMs(record, now) : undefined;
  const until = Math.max(stated ?? now.getTime() + opencodeReprobeMs(provider, write.config), standing ?? 0);
  // A stated reset is taken on trust only up to the re-probe, as every other stated window is, so a misparse self-corrects.
  const recheck = stated === undefined ? {} : { recheckAt: recheckFrom(until, now) };
  put(write.healthKey, { state: "exhausted", until: new Date(until).toISOString(), ...recheck, failureClass: "quota", ...(write.model ? { model: write.model } : {}), ...observed }, write.host, now);
}

/**
 * Record an opencode failure against the key it belongs to. Returns whether it
 * was handled: false leaves the caller's own recording in force (a failure this
 * module does not classify, or a pay-as-you-go provider's 402).
 */
export function recordOpencodeFailure(write: OpencodeHealthWrite): boolean {
  const provider = providerOfOpencodeHealthKey(write.healthKey);
  const subscription = isOpencodeSubscriptionProvider(provider, write.config);
  const failure = failureOf(write, subscription);
  if (!failure || provider === undefined) return false;
  const now = write.now ?? new Date();
  const observed = { reason: reasonOf(failure), observedAt: now.toISOString() };

  if (failure.kind === "model-access") return holdModel(write, provider, now, observed);
  if (failure.kind === "auth") {
    holdSignedOut(write, provider, now, observed);
    return true;
  }
  // A pay-as-you-go provider's spent balance, and any other provider's window, keep the caller's own recording.
  if (!subscription) return false;
  holdSpentAllowance(write, provider, now, observed);
  return true;
}

/** A turn its target answered: what it contradicts is cleared under the target's key (`linkHealthKey`) and, on
 *  opencode, under its (provider, model) key, whose refusal a turn on that model has shown lifted. `servedOn` is
 *  the host the turn ran on when it is not this machine: see `recordEngineServed`. */
export function recordTurnServed(turn: { engine: string; key: string; startedMs: number; model: string | undefined; servedOn?: string }, now: Date = new Date()): void {
  recordEngineServed(turn.key, turn.startedMs, turn.model, now, turn.servedOn);
  const modelKey = turn.engine === "opencode" ? opencodeModelHealthKey(turn.model) : undefined;
  if (modelKey !== undefined) recordEngineServed(modelKey, turn.startedMs, turn.model, now, turn.servedOn);
}

/** When the quota hold recorded under `key` ends, in unix seconds: the moment a stand-in's window should end too, so a
 *  provider held for its re-probe interval is not stood in for six hours. Undefined for any other record. */
export function quotaHoldEndsAtSeconds(key: string, now: Date = new Date()): number | undefined {
  const record = readStore()[key];
  const until = record?.failureClass === "quota" ? liveUntilMs(record, now) : undefined;
  return until === undefined ? undefined : Math.floor(until / 1000);
}

function reasonOf(failure: OpencodeFailure): string {
  switch (failure.kind) {
    case "quota": return "the provider reports no usable allowance (HTTP 402)";
    case "usage-limit": return "the provider reports its usage limit is spent";
    case "auth": return "the provider's API key is expired or invalid; sign in again";
    case "model-access": return "this model is not enabled for the account (or its region has not been opted in)";
  }
}
