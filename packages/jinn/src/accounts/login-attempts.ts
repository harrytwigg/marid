import type { Database as DatabaseType } from "better-sqlite3";
import { isoNow } from "./ids.js";

/** 5 failures per address or 20 per client IP within 15 minutes answer 429. Rows are pruned after an hour. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_PER_EMAIL = 5;
export const LOGIN_MAX_PER_IP = 20;
const PRUNE_AFTER_MS = 60 * 60 * 1000;

export const emailKey = (email: string): string => `email:${email.trim().toLowerCase()}`;
export const ipKey = (ip: string): string => `ip:${ip}`;

export interface RateDecision { allowed: boolean; retryAfterSeconds: number }

function countAndOldest(db: DatabaseType, key: string, since: string): { n: number; oldest: string | null } {
  const row = db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_attempts WHERE email_or_ip = ? AND at > ?").get(key, since) as { n: number; oldest: string | null };
  return { n: Number(row.n), oldest: row.oldest };
}

/**
 * `ip` is the peer to count, or undefined for a peer that must not share a bucket (a loopback peer is every
 * client behind a local tunnel or proxy, so one bucket would lock them all out together).
 */
export interface AttemptKeys { email?: string; ip: string | undefined }

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
    db.prepare("DELETE FROM login_attempts WHERE at <= ?").run(isoNow(now - PRUNE_AFTER_MS));
    return ids;
  })();
}

export function releaseAttempt(db: DatabaseType, ids: readonly number[]): void {
  const del = db.prepare("DELETE FROM login_attempts WHERE rowid = ?");
  for (const id of ids) del.run(id);
}
