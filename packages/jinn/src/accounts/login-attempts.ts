import type { Database as DatabaseType } from "better-sqlite3";
import { isoNow } from "./ids.js";

/** 5 failures per address or 20 per client IP within 15 minutes answer 429. Rows are pruned after an hour. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_PER_EMAIL = 5;
export const LOGIN_MAX_PER_IP = 20;
const PRUNE_AFTER_MS = 60 * 60 * 1000;

export const emailKey = (email: string): string => `email:${email.trim().toLowerCase()}`;
export const ipKey = (ip: string | undefined): string => `ip:${ip ?? "unknown"}`;

export interface RateDecision { allowed: boolean; retryAfterSeconds: number }

function countAndOldest(db: DatabaseType, key: string, since: string): { n: number; oldest: string | null } {
  const row = db.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_attempts WHERE email_or_ip = ? AND at > ?").get(key, since) as { n: number; oldest: string | null };
  return { n: Number(row.n), oldest: row.oldest };
}

/**
 * Whether any of the keys is already at its limit. Called BEFORE any password is hashed, so a locked
 * address or IP costs the gateway one indexed read and nothing else.
 */
export function checkAttemptLimits(
  db: DatabaseType,
  keys: { email?: string; ip: string | undefined },
  now = Date.now(),
): RateDecision {
  const since = isoNow(now - LOGIN_WINDOW_MS);
  let retryAfter = 0;
  const probe = (key: string, max: number): void => {
    const { n, oldest } = countAndOldest(db, key, since);
    if (n >= max && oldest) retryAfter = Math.max(retryAfter, Math.ceil((Date.parse(oldest) + LOGIN_WINDOW_MS - now) / 1000));
  };
  if (keys.email !== undefined) probe(emailKey(keys.email), LOGIN_MAX_PER_EMAIL);
  probe(ipKey(keys.ip), LOGIN_MAX_PER_IP);
  return retryAfter > 0 ? { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) } : { allowed: true, retryAfterSeconds: 0 };
}

/** Count one failure against the address (when given) and the IP. */
export function recordFailure(db: DatabaseType, keys: { email?: string; ip: string | undefined }, now = Date.now()): void {
  const at = isoNow(now);
  const insert = db.prepare("INSERT INTO login_attempts (email_or_ip, at) VALUES (?, ?)");
  db.transaction(() => {
    if (keys.email !== undefined) insert.run(emailKey(keys.email), at);
    insert.run(ipKey(keys.ip), at);
    db.prepare("DELETE FROM login_attempts WHERE at <= ?").run(isoNow(now - PRUNE_AFTER_MS));
  })();
}
