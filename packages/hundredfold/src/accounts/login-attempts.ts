import type { Database as DatabaseType } from "better-sqlite3";
import { isoNow } from "./ids.js";

/**
 * 5 failures per address or 20 per client IP within 15 minutes answer 429, and so do the 101st failed sign-in
 * across the whole instance from an address that has never signed in. Rows are pruned after an hour, except the
 * `ok:` rows that remember a successful sign-in, which are kept 30 days.
 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_PER_EMAIL = 5;
export const LOGIN_MAX_PER_IP = 20;
export const LOGIN_MAX_INSTANCE = 100;
export const RECENT_SUCCESS_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 60 * 60 * 1000;
export const INSTANCE_KEY = "instance:login";
/** `ok:` keys sort between these two bounds, so one indexed range covers them all. */
const OK_FROM = "ok:";
const OK_TO = "ok;";

export const emailKey = (email: string): string => `email:${email.trim().toLowerCase()}`;
export const ipKey = (ip: string): string => `ip:${ip}`;
export const successKey = (address: string): string => `ok:${address}`;

export interface RateDecision { allowed: boolean; retryAfterSeconds: number }

function countAndOldest(db: DatabaseType, key: string, since: string): { n: number; oldest: string | null } {
  const row = db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_attempts WHERE email_or_ip = ? AND at > ?").get(key, since) as { n: number; oldest: string | null };
  return { n: Number(row.n), oldest: row.oldest };
}

/**
 * `ip` is the peer to count, or undefined for a peer that must not share a bucket (a loopback peer is every
 * client behind a local tunnel or proxy, so one bucket would lock them all out together).
 */
export interface AttemptKeys { email?: string; ip: string | undefined; /** Also count it against the instance-wide failure budget (sign-in only). */ instance?: boolean }

/**
 * Whether any of the keys is already at its limit. Called BEFORE any password is hashed, so a locked
 * address or IP costs the gateway one indexed read and nothing else.
 */
export function checkAttemptLimits(
  db: DatabaseType,
  keys: AttemptKeys,
  now = Date.now(),
): RateDecision {
  const since = isoNow(now - LOGIN_WINDOW_MS);
  let retryAfter = 0;
  const probe = (key: string, max: number): void => {
    const { n, oldest } = countAndOldest(db, key, since);
    if (n >= max && oldest) retryAfter = Math.max(retryAfter, Math.ceil((Date.parse(oldest) + LOGIN_WINDOW_MS - now) / 1000));
  };
  if (keys.email !== undefined) probe(emailKey(keys.email), LOGIN_MAX_PER_EMAIL);
  if (keys.ip !== undefined) probe(ipKey(keys.ip), LOGIN_MAX_PER_IP);
  return retryAfter > 0 ? { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) } : { allowed: true, retryAfterSeconds: 0 };
}

/** Count one failure against the address (when given) and the IP (when it has a bucket). */
export function recordFailure(db: DatabaseType, keys: AttemptKeys, now = Date.now()): void {
  reserveAttempt(db, keys, now);
}

/**
 * Count an attempt BEFORE its password is hashed, so concurrent guesses cannot all pass the limit check
 * while the first ones are still hashing. A correct password gives its reservation back with `releaseAttempt`;
 * a wrong one simply leaves it in place as the failure.
 */
export function reserveAttempt(db: DatabaseType, keys: AttemptKeys, now = Date.now()): number[] {
  const at = isoNow(now);
  const insert = db.prepare("INSERT INTO login_attempts (email_or_ip, at) VALUES (?, ?)");
  return db.transaction(() => {
    const ids: number[] = [];
    if (keys.email !== undefined) ids.push(Number(insert.run(emailKey(keys.email), at).lastInsertRowid));
    if (keys.ip !== undefined) ids.push(Number(insert.run(ipKey(keys.ip), at).lastInsertRowid));
    if (keys.instance) ids.push(Number(insert.run(INSTANCE_KEY, at).lastInsertRowid));
    prune(db, now);
    return ids;
  })();
}

export function releaseAttempt(db: DatabaseType, ids: readonly number[]): void {
  const del = db.prepare("DELETE FROM login_attempts WHERE rowid = ?");
  for (const id of ids) del.run(id);
}

/** Attempts go after an hour, successes after 30 days: one range DELETE each, both on the (key, at) index. */
function prune(db: DatabaseType, now: number): void {
  db.prepare("DELETE FROM login_attempts WHERE (email_or_ip < ? OR email_or_ip >= ?) AND at <= ?").run(OK_FROM, OK_TO, isoNow(now - PRUNE_AFTER_MS));
  db.prepare("DELETE FROM login_attempts WHERE email_or_ip >= ? AND email_or_ip < ? AND at <= ?").run(OK_FROM, OK_TO, isoNow(now - RECENT_SUCCESS_MS));
}

/** Remember that this (non-shared) address signed in successfully, once: an older row for it is replaced. */
export function recordSuccess(db: DatabaseType, address: string, now = Date.now()): void {
  db.transaction(() => {
    db.prepare("DELETE FROM login_attempts WHERE email_or_ip = ?").run(successKey(address));
    db.prepare("INSERT INTO login_attempts (email_or_ip, at) VALUES (?, ?)").run(successKey(address), isoNow(now));
  })();
}

function hasRecentSuccess(db: DatabaseType, address: string, now: number): boolean {
  return !!db.prepare("SELECT 1 FROM login_attempts WHERE email_or_ip = ? AND at > ? LIMIT 1").get(successKey(address), isoNow(now - RECENT_SUCCESS_MS));
}

/**
 * Whether the instance may take another sign-in attempt from `address` (the resolved client address, or
 * undefined when it is shared and so can never be recognised). Over the budget only an address with a recent
 * success gets in. That bounds a stranger spraying passwords from new addresses, at a price: anyone who can
 * sign in from an address once (any member) keeps that address usable for 30 days, and a person signing in
 * from a new address, or from behind a shared one, waits out the window.
 */
export function checkInstanceBudget(db: DatabaseType, input: { address: string | undefined; max: number }, now = Date.now()): RateDecision {
  const { n, oldest } = countAndOldest(db, INSTANCE_KEY, isoNow(now - LOGIN_WINDOW_MS));
  if (n < input.max || !oldest) return { allowed: true, retryAfterSeconds: 0 };
  if (input.address !== undefined && hasRecentSuccess(db, input.address, now)) return { allowed: true, retryAfterSeconds: 0 };
  const retry = Math.ceil((Date.parse(oldest) + LOGIN_WINDOW_MS - now) / 1000);
  return { allowed: false, retryAfterSeconds: Math.max(1, retry) };
}

/** Says once per window that the budget tripped, so a sustained spray logs one line, not one per request. */
export interface BudgetWarner { shouldWarn(now: number): boolean }
export function createBudgetWarner(): BudgetWarner {
  let quietUntil = 0;
  return {
    shouldWarn(now) {
      if (now < quietUntil) return false;
      quietUntil = now + LOGIN_WINDOW_MS;
      return true;
    },
  };
}
