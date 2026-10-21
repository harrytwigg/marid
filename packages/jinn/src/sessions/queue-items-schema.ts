// The shape of `queue_items`: its DDL and the idempotent upgrades that keep an
// existing home in step. Split out of `migrate.ts` so the table's schema and the
// dedupe identity it enforces read as one thing; `migrate.ts` re-exports both, so
// `shared/db.ts` still sequences them alongside every other migration.
import Database from 'better-sqlite3';

export const CREATE_QUEUE_ITEMS_TABLE = `
      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        internal INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        message_id TEXT,
        dispatch_payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_session
        ON queue_items (session_key, status, position);
    `;

/**
 * Additive migration for restart-safe system work. Internal queue rows use the
 * same durable ordering/replay machinery as user messages, but stay out of the
 * operator-facing queue panel and its cancel/clear controls.
 *
 * `dedupe_key` is the durable identity of an agent-initiated send: a replayed
 * tool call collides on the unique index instead of minting a second row (and
 * with it a second engine turn). The index is partial on `status` as well as on
 * the key, so identity only binds while the send is unsettled — once the first
 * row completes, a genuinely repeated later send is a new intent and enqueues
 * normally.
 *
 * `message_id` links a parked row to the transcript row the operator can see,
 * so the chat can tell which of its own bubbles are still waiting and edit the
 * two together. Null on every row enqueued by a path that has no message.
 *
 * `dispatch_payload` holds the rest of what the turn runs on - its attachments
 * and whether its text was spoken. Those used to live only in the dispatch
 * closure, which a row edited or replayed after a restart no longer has to hand.
 * Null whenever there is nothing extra to carry, which is most rows.
 */
export function migrateQueueItemsSchema(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(queue_items)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('internal')) {
    database.exec('ALTER TABLE queue_items ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('dedupe_key')) {
    database.exec('ALTER TABLE queue_items ADD COLUMN dedupe_key TEXT');
  }
  if (!names.has('message_id')) {
    database.exec('ALTER TABLE queue_items ADD COLUMN message_id TEXT');
  }
  if (!names.has('dispatch_payload')) {
    database.exec('ALTER TABLE queue_items ADD COLUMN dispatch_payload TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_items_dedupe
      ON queue_items (dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running')
  `);
}
