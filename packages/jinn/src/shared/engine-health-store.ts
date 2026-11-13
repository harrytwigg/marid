import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { opencodeCredentialFingerprint, providerOfOpencodeHealthKey } from "./opencode-subscription.js";
import { JINN_HOME } from "./paths.js";

/**
 * The engine-health record, and the file it lives in.
 *
 * Split from the policy that writes and reads it so that "what a record IS and
 * when it stops being true" can be reasoned about — and tested — without the
 * chain-walking that consumes it. Everything here is advisory and best-effort by
 * construction: reads and writes swallow their own errors, and every record
 * carries the moment it expires, so a record can never outlive its own window
 * because a sweeper did not run.
 */

export type EngineHealthState = "ok" | "exhausted" | "degraded";

export type OpencodeFailureClass = "quota" | "auth" | "model-access";

export interface EngineHealth {
  state: EngineHealthState;
  /** ISO. The reopening the engine itself stated, verbatim: what every display
   *  surface shows, and the moment the record is spent. */
  until?: string;
  /** ISO. When a dispatcher may offer the engine a probing turn again, on an
   *  `exhausted` record. Internal — a shorter belief than `until`, never a
   *  shorter claim, so it is deliberately not displayed anywhere. */
  recheckAt?: string;
  /** The binding quota window as telemetry names it (`5h`, `7d`), when it does. */
  window?: string;
  /**
   * The machine this record is about, when it is about ONE machine rather than
   * the account.
   *
   * Almost every record here describes an allowance — a provider's quota window
   * — which is the same fact wherever the turn runs. A login is not: a remote
   * employee signs its engine in on its own host, and the gateway cannot read
   * that login or speak for it. Recording one without saying whose it was is
   * how a dead login on the orchestrator reroutes sessions that were never
   * going to use it. Absent = about the account, and applies everywhere.
   */
  host?: string;
  /**
   * The model the limit was observed on, when a turn on that model hit it. A limit
   * can belong to one model (a per-model weekly bucket) although it is held under
   * the account's key, so only a turn served on the same model says it lifted.
   * Observation metadata like `host`: a re-probe does not carry it over. Absent on
   * a record from a usage readout or a login failure, which are about no model.
   */
  model?: string;
  /**
   * What kind of fact an opencode record holds: `quota` (a spent allowance or
   * balance), `auth` (the provider's key is expired or invalid) or `model-access`
   * (one model is not enabled for the account). Absent on every other record.
   * Read by the limits displays, which say why the target is out.
   */
  failureClass?: OpencodeFailureClass;
  /**
   * Internal: an opaque identity of the credential an `auth` record was written
   * against. When the credential stored now has a different one the record is
   * about a key that has since been replaced and reads as cleared. Never shown
   * and never sent out; see {@link publicHealth}.
   */
  credentialFingerprint?: string;
  reason?: string;
  observedAt?: string;
  /**
   * ISO. Set only on an `ok` record that a positive observation wrote over a limit
   * that had not run out yet (a reading showing headroom, a turn that was served,
   * the operator). A record that merely lapsed reads `ok` without it, and only a
   * positive clear may end a held stand-in early.
   */
  clearedAt?: string;
}

/** Live readings keyed by engine name. An engine with no entry is healthy. */
export type EngineHealthReading = Record<string, EngineHealth>;

const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");

/** This machine's name, as a record about it is stamped and as a local session matches a record's `host`. */
export function localHostName(): string {
  try {
    return os.hostname();
  } catch {
    return "localhost";
  }
}

const HEALTH_STATES: readonly string[] = ["ok", "exhausted", "degraded"];

export function readStore(): EngineHealthReading {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: EngineHealthReading = {};
    for (const [engine, record] of Object.entries(parsed as Record<string, EngineHealth | null>)) {
      if (record && typeof record === "object" && HEALTH_STATES.includes(record.state)) store[engine] = record;
    }
    return store;
  } catch {
    return {};
  }
}

export function writeStore(store: EngineHealthReading): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // best-effort only
  }
}

/**
 * Whether a record has outlived what it stated. Expiry is what the clock says
 * rather than what a sweeper got around to, so a record can never outlive its
 * own window — and an `until` that will not parse counts as spent, because
 * fail-open is the only safe direction for advice.
 */
export function isSpent(record: EngineHealth, now: Date): boolean {
  if (record.state === "ok") return true;
  if (record.until === undefined) return false;
  const until = Date.parse(record.until);
  return !Number.isFinite(until) || until <= now.getTime();
}

/** A record as the readers see it: without the fields that are the store's own. */
export function publicHealth(record: EngineHealth): EngineHealth {
  const { credentialFingerprint: _fingerprint, ...rest } = record;
  return rest;
}

/** An `auth` record whose credential is not the one stored now: the key it was
 *  written against has been replaced, or cannot be read any more. Either way the
 *  record says nothing reliable about the credential in use, and fail-open is the
 *  only safe direction for advice. */
function credentialChanged(key: string, record: EngineHealth): boolean {
  if (record.failureClass !== "auth" || record.credentialFingerprint === undefined) return false;
  return opencodeCredentialFingerprint(providerOfOpencodeHealthKey(key), undefined) !== record.credentialFingerprint;
}

/** Every engine something has been observed about, with a record whose window
 *  has passed reading back as `ok`. A stored `ok` is a positive clear and is kept
 *  as written: its `clearedAt` is what tells a clear from a lapse. */
export function readEngineHealth(now: Date = new Date()): EngineHealthReading {
  const live: EngineHealthReading = {};
  for (const [engine, record] of Object.entries(readStore())) {
    if (record.state !== "ok" && isSpent(record, now)) live[engine] = { state: "ok", ...(record.observedAt ? { observedAt: record.observedAt } : {}) };
    else if (record.state !== "ok" && credentialChanged(engine, record)) live[engine] = { state: "ok", clearedAt: now.toISOString(), observedAt: now.toISOString(), reason: "the credential changed" };
    else live[engine] = publicHealth(record);
  }
  return live;
}
