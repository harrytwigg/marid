// Durable acceptance of one incoming turn: the chat message and, for a
// notification, the internal queue row that makes it survive a crash before
// dispatch. Split out of `gateway/api.ts` so the two writes commit together and
// so an agent-initiated send can carry an idempotency identity.
import { createHash, randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { insertMessage, type MessageMedia } from './registry.js';
import type { JsonObject } from '../shared/types.js';
import { lateralSendPrefix, withdrawOwnSend, type SupersedeOutcome } from './queued-send-supersede.js';

/**
 * The durable identity of one agent-initiated (lateral) send.
 *
 * Derived from the send's CONTENT — caller, target, message — rather than from
 * the MCP call's `x-jinn-activity-operation` id, because that id is minted per
 * `tools/call` inside the MCP server process: a transport replay of the same
 * pending call re-mints it, so it cannot name the retry it would have to
 * collapse. Caller, target and message body survive the replay and can.
 */
export function lateralSendDedupeKey(callerSessionId: string, targetSessionId: string, message: string): string {
  const digest = createHash('sha256').update(message).digest('hex');
  return `${lateralSendPrefix(callerSessionId, targetSessionId)}${digest}`;
}

export type IncomingTurnClaim =
  | { deduplicated: true; queueItemId: string; messageId?: string; superseded?: SupersedeOutcome }
  | { deduplicated: false; queueItemId?: string; messageId: string; superseded?: SupersedeOutcome };

export interface IncomingTurn {
  sessionId: string;
  sessionKey: string;
  /** Engine-facing text, queued verbatim so a crash before dispatch replays it. */
  prompt: string;
  /** Notifications queue a durable internal intent; user messages are enqueued
   *  by the caller as a visible queue-panel item instead. */
  isNotification: boolean;
  role: string;
  /** What the transcript stores — the display banner for a notification. */
  content: string;
  media?: MessageMedia[];
  meta?: JsonObject;
  /** Set only for tool-origin lateral sends; absent means no dedupe at all, so
   *  the operator/UI path is unchanged. */
  dedupeKey?: string;
  /** Preserve this identity after the queue item settles. Used when the caller
   *  has a true operation id (Talk provider call), never for content-derived
   *  lateral-send keys where a later identical sentence is a new intent. */
  durableDedupe?: boolean;
  /** Notifications default to an internal queue row. Talk operator turns are
   *  visible user work and opt into the ordinary queue surface. */
  queueVisibility?: 'internal' | 'visible';
  /** An earlier parked send of the same sender that this turn replaces, taken
   *  back in the same transaction that accepts this one. Only meaningful beside
   *  a lateral `dedupeKey`, which is what names the sender. */
  supersedes?: { callerSessionId: string; queueItemId: string };
}

interface DurableMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  media: string | null;
  meta: string | null;
}

interface DurableQueueRow {
  id: string;
  session_id: string;
  session_key: string;
  prompt: string;
  internal: number;
}

function durableMessageId(key: string): string {
  return `talk-${createHash('sha256').update(key).digest('hex')}`;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function messageMatches(message: DurableMessageRow, turn: IncomingTurn): boolean {
  return message.session_id === turn.sessionId
    && message.role === turn.role
    && message.content === turn.content
    && message.media === json(turn.media)
    && message.meta === json(turn.meta);
}

function queueMatches(queue: DurableQueueRow, turn: IncomingTurn): boolean {
  return queue.session_id === turn.sessionId
    && queue.session_key === turn.sessionKey
    && queue.prompt === turn.prompt
    && queue.internal === (turn.queueVisibility === 'visible' ? 0 : 1);
}

function durableReplay(db: ReturnType<typeof initDb>, turn: IncomingTurn): IncomingTurnClaim | null {
  if (!turn.durableDedupe) return null;
  if (!turn.dedupeKey || !turn.isNotification) throw new Error('durable incoming turns require a queued dedupe identity');
  const messageId = durableMessageId(turn.dedupeKey);
  const message = db.prepare(
    'SELECT id, session_id, role, content, media, meta FROM messages WHERE id = ?',
  ).get(messageId) as DurableMessageRow | undefined;
  if (!message) return null;
  const queue = db.prepare(
    'SELECT id, session_id, session_key, prompt, internal FROM queue_items WHERE dedupe_key = ? ORDER BY created_at, rowid LIMIT 1',
  ).get(turn.dedupeKey) as DurableQueueRow | undefined;
  if (!messageMatches(message, turn) || !queue || !queueMatches(queue, turn)) {
    throw new Error('incoming turn dedupe key was already used for different input');
  }
  return { deduplicated: true, queueItemId: queue.id, messageId };
}

/**
 * What accepting a turn does once its message exists, inside the accepting
 * transaction so the writes commit as one. Every internal row records its
 * bubble (`message_id`), whether or not it supersedes anything, so that a
 * withdrawal, by its sender or by a stop, can drop the row and the bubble
 * together. A turn that replaces an earlier parked send of the same sender
 * then takes that one back.
 */
function acceptedClaim(
  db: ReturnType<typeof initDb>,
  turn: IncomingTurn,
  queueItemId: string | undefined,
  messageId: string,
): IncomingTurnClaim {
  if (queueItemId && turn.queueVisibility !== 'visible') {
    db.prepare('UPDATE queue_items SET message_id = ? WHERE id = ?').run(messageId, queueItemId);
  }
  if (!turn.supersedes) return { deduplicated: false, queueItemId, messageId };
  const superseded = withdrawOwnSend(db, turn.supersedes.callerSessionId, turn.sessionId, turn.supersedes.queueItemId);
  return { deduplicated: false, queueItemId, messageId, superseded };
}

/**
 * A send that collided with a live row of the same identity is not queued
 * again, but it can still replace a different parked send of the same sender:
 * "alpha", "beta", then "beta" superseding "alpha" must leave only "beta". When
 * the superseded row IS the winner (the same words sent again) nothing is taken
 * back, and a replayed superseding call finds its target already gone; neither
 * is reported as a withdrawal.
 */
function duplicateClaim(db: ReturnType<typeof initDb>, turn: IncomingTurn, winnerId: string): IncomingTurnClaim {
  const target = turn.supersedes;
  if (!target || target.queueItemId === winnerId) return { deduplicated: true, queueItemId: winnerId };
  const superseded = withdrawOwnSend(db, target.callerSessionId, turn.sessionId, target.queueItemId);
  return superseded.outcome === 'withdrawn'
    ? { deduplicated: true, queueItemId: winnerId, superseded }
    : { deduplicated: true, queueItemId: winnerId };
}

/**
 * Accept an incoming turn in ONE transaction, so a failed message write can
 * never leave an orphan queue row behind (or the reverse).
 *
 * With a `dedupeKey`, the partial unique index on `queue_items.dedupe_key` is
 * the concurrency arbiter: a replayed send inserts nothing, writes no second
 * message, and reuses the winning row's id — the same shape
 * `claimSessionDelivery` gives the child-callback outbox.
 */
export function claimIncomingTurn(turn: IncomingTurn): IncomingTurnClaim {
  const db = initDb();
  const claim = db.transaction((): IncomingTurnClaim => {
    const replay = durableReplay(db, turn);
    if (replay) return replay;
    let queueItemId: string | undefined;
    if (turn.isNotification) {
      queueItemId = randomUUID();
      const position = (db.prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'",
      ).get(turn.sessionKey) as { pos: number }).pos;
      const internal = turn.queueVisibility === 'visible' ? 0 : 1;
      const inserted = db.prepare(
        `INSERT INTO queue_items (id, session_id, session_key, prompt, status, internal, position, created_at, dedupe_key)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).run(queueItemId, turn.sessionId, turn.sessionKey, turn.prompt, internal, position, new Date().toISOString(), turn.dedupeKey ?? null);
      if (inserted.changes === 0) {
        if (turn.durableDedupe) throw new Error('incoming turn dedupe key is owned by a different operation');
        const winner = db.prepare(
          "SELECT id FROM queue_items WHERE dedupe_key = ? AND status IN ('pending', 'running')",
        ).get(turn.dedupeKey) as { id: string } | undefined;
        if (!winner) throw new Error(`queue item for session ${turn.sessionId} conflicted with no live row holding its dedupe key`);
        return duplicateClaim(db, turn, winner.id);
      }
    }
    const presetId = turn.durableDedupe && turn.dedupeKey ? durableMessageId(turn.dedupeKey) : undefined;
    const messageId = insertMessage(turn.sessionId, turn.role, turn.content, turn.media, undefined, presetId, turn.meta);
    return acceptedClaim(db, turn, queueItemId, messageId);
  });
  return claim.immediate();
}
