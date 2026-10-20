import { randomUUID } from "node:crypto";
import { initDb } from "../shared/db.js";
import type { Heartbeat } from "./types.js";

export type { Heartbeat } from "./types.js";

/** Interval floor. A session may not schedule itself more often than this —
 *  below a minute the wake-ups arrive faster than a turn can settle. */
export const MIN_EVERY_SECONDS = 60;
/** Concurrent armed heartbeats one session may hold. */
export const MAX_ARMED_PER_SESSION = 5;
/** The stored text is delivered verbatim, so it is capped like a prompt, not a note. */
export const MESSAGE_MAX_CHARS = 2000;

/** A refused arm: the caller asked for something outside a stated limit. The
 *  message names the limit and the fix; routes map it to 422. */
export class HeartbeatLimitError extends Error {}

export interface ArmHeartbeatInput {
  ownerSessionId: string;
  message: string;
  everySeconds: number;
  /** Disarm after this many deliveries. */
  maxFires?: number;
  /** Disarm at this instant (epoch ms) without delivering. */
  expiresAt?: number;
}

interface HeartbeatRow {
  id: string;
  owner_session_id: string;
  message: string;
  every_seconds: number;
  next_fire_at: number;
  fire_count: number;
  max_fires: number | null;
  expires_at: number | null;
  status: Heartbeat["status"];
  created_at: string;
  disarmed_at: string | null;
  disarmed_reason: string | null;
  purpose: string | null;
}

function toHeartbeat(row: HeartbeatRow): Heartbeat {
  return {
    id: row.id,
    ownerSessionId: row.owner_session_id,
    message: row.message,
    everySeconds: row.every_seconds,
    nextFireAt: row.next_fire_at,
    fireCount: row.fire_count,
    maxFires: row.max_fires,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    disarmedAt: row.disarmed_at,
    disarmedReason: row.disarmed_reason,
    purpose: row.purpose,
  };
}

function validateInterval(everySeconds: unknown): number {
  if (typeof everySeconds !== "number" || !Number.isInteger(everySeconds)) {
    throw new HeartbeatLimitError("everySeconds must be a whole number of seconds.");
  }
  if (everySeconds < MIN_EVERY_SECONDS) {
    throw new HeartbeatLimitError(
      `everySeconds is ${everySeconds}, below the ${MIN_EVERY_SECONDS}-second floor. ` +
      `Arm it at ${MIN_EVERY_SECONDS} or more; a session cannot wake itself faster than that.`,
    );
  }
  return everySeconds;
}

function validateMessage(message: unknown): string {
  if (typeof message !== "string" || !message.trim()) {
    throw new HeartbeatLimitError("message is required and must be a non-empty string.");
  }
  if (message.length > MESSAGE_MAX_CHARS) {
    throw new HeartbeatLimitError(
      `message is ${message.length} characters, over the ${MESSAGE_MAX_CHARS}-character cap. ` +
      `Shorten it to the reminder itself — the text is delivered verbatim, so keep the detail in your notes.`,
    );
  }
  return message;
}

function validateMaxFires(maxFires: unknown): number | null {
  if (maxFires === undefined || maxFires === null) return null;
  if (typeof maxFires !== "number" || !Number.isInteger(maxFires) || maxFires < 1) {
    throw new HeartbeatLimitError("maxFires must be a positive whole number when provided.");
  }
  return maxFires;
}

function validateExpiresAt(expiresAt: unknown): number | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new HeartbeatLimitError("expiresAt must be an epoch-millisecond timestamp when provided.");
  }
  return Math.floor(expiresAt);
}

function countArmed(ownerSessionId: string): number {
  return initDb()
    .prepare("SELECT COUNT(*) FROM heartbeats WHERE owner_session_id = ? AND status = 'armed'")
    .pluck()
    .get(ownerSessionId) as number;
}

/**
 * Arm a heartbeat for `ownerSessionId`. The owner is always supplied by the
 * gateway from the caller's verified identity, never by the request body.
 */
export function armHeartbeat(input: ArmHeartbeatInput, now = Date.now()): Heartbeat {
  const message = validateMessage(input.message);
  const everySeconds = validateInterval(input.everySeconds);
  const maxFires = validateMaxFires(input.maxFires);
  const expiresAt = validateExpiresAt(input.expiresAt);
  const armed = countArmed(input.ownerSessionId);
  if (armed >= MAX_ARMED_PER_SESSION) {
    throw new HeartbeatLimitError(
      `this session already holds ${armed} armed heartbeats, the maximum of ${MAX_ARMED_PER_SESSION}. ` +
      `Stop one with stop_heartbeat before arming another.`,
    );
  }
  const heartbeat: Heartbeat = {
    id: randomUUID(),
    ownerSessionId: input.ownerSessionId,
    message,
    everySeconds,
    nextFireAt: now + everySeconds * 1000,
    fireCount: 0,
    maxFires,
    expiresAt,
    status: "armed",
    createdAt: new Date(now).toISOString(),
    disarmedAt: null,
    disarmedReason: null,
    purpose: null,
  };
  initDb().prepare(`
    INSERT INTO heartbeats (
      id, owner_session_id, message, every_seconds, next_fire_at,
      fire_count, max_fires, expires_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'armed', ?)
  `).run(
    heartbeat.id,
    heartbeat.ownerSessionId,
    heartbeat.message,
    heartbeat.everySeconds,
    heartbeat.nextFireAt,
    heartbeat.maxFires,
    heartbeat.expiresAt,
    heartbeat.createdAt,
  );
  return heartbeat;
}

export function getHeartbeat(id: string): Heartbeat | undefined {
  const row = initDb().prepare("SELECT * FROM heartbeats WHERE id = ?").get(id) as HeartbeatRow | undefined;
  return row ? toHeartbeat(row) : undefined;
}

/** The caller's own armed heartbeats. Another session's rows are not reachable
 *  through this function, which is the whole ownership boundary. */
export function listHeartbeatsForSession(ownerSessionId: string): Heartbeat[] {
  const rows = initDb().prepare(`
    SELECT * FROM heartbeats
    WHERE owner_session_id = ? AND status = 'armed'
    ORDER BY next_fire_at ASC, id ASC
  `).all(ownerSessionId) as HeartbeatRow[];
  return rows.map(toHeartbeat);
}

/**
 * Disarm `id`, but only if `ownerSessionId` owns it. Returns false for an
 * unknown id, someone else's id, and an already-disarmed row alike — the caller
 * reports all three as "not found" so a heartbeat's existence never leaks to a
 * session that does not own it.
 */
export function stopHeartbeat(id: string, ownerSessionId: string, now = Date.now()): boolean {
  const result = initDb().prepare(`
    UPDATE heartbeats
    SET status = 'disarmed', disarmed_at = ?, disarmed_reason = 'stopped'
    WHERE id = ? AND owner_session_id = ? AND status = 'armed'
  `).run(new Date(now).toISOString(), id, ownerSessionId);
  return result.changes === 1;
}

/** Every armed heartbeat due at `now`, oldest deadline first. */
export function claimDueHeartbeats(now: number): Heartbeat[] {
  const rows = initDb().prepare(`
    SELECT * FROM heartbeats
    WHERE status = 'armed' AND next_fire_at <= ?
    ORDER BY next_fire_at ASC, id ASC
  `).all(now) as HeartbeatRow[];
  return rows.map(toHeartbeat);
}

export function disarmHeartbeat(id: string, reason: string, now = Date.now()): void {
  initDb().prepare(`
    UPDATE heartbeats
    SET status = 'disarmed', disarmed_at = ?, disarmed_reason = ?
    WHERE id = ? AND status = 'armed'
  `).run(new Date(now).toISOString(), reason, id);
}

/** Deletion of a session disarms everything it armed. Stopping does not — a
 *  stopped session is recoverable and its heartbeats should survive with it. */
export function disarmHeartbeatsForSession(ownerSessionId: string, now = Date.now()): number {
  const result = initDb().prepare(`
    UPDATE heartbeats
    SET status = 'disarmed', disarmed_at = ?, disarmed_reason = 'owner-session-deleted'
    WHERE owner_session_id = ? AND status = 'armed'
  `).run(new Date(now).toISOString(), ownerSessionId);
  return result.changes;
}

/**
 * Book one delivery against `id` and schedule the next.
 *
 * The next deadline is computed from `now`, never from the deadline just met, so
 * a heartbeat whose gateway was down for ten intervals fires once and then
 * resumes on a fresh interval instead of replaying every tick it slept through.
 */
export function advanceHeartbeat(id: string, now = Date.now()): Heartbeat | undefined {
  const current = getHeartbeat(id);
  if (!current || current.status !== "armed") return current;
  const fireCount = current.fireCount + 1;
  if (current.maxFires !== null && fireCount >= current.maxFires) {
    initDb().prepare(`
      UPDATE heartbeats
      SET fire_count = ?, status = 'disarmed', disarmed_at = ?, disarmed_reason = 'max-fires-reached'
      WHERE id = ?
    `).run(fireCount, new Date(now).toISOString(), id);
    return getHeartbeat(id);
  }
  initDb().prepare("UPDATE heartbeats SET fire_count = ?, next_fire_at = ? WHERE id = ?")
    .run(fireCount, now + current.everySeconds * 1000, id);
  return getHeartbeat(id);
}
