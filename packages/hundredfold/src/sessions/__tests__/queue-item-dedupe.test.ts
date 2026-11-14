import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateQueueItemsSchema } from "../queue-items-schema.js";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from HUNDREDFOLD_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-queue-dedupe-"));
process.env.HUNDREDFOLD_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
let reg: Reg;
type IncomingTurn = typeof import("../incoming-turn.js");
let turns: IncomingTurn;

beforeAll(async () => {
  reg = await import("../registry.js");
  turns = await import("../incoming-turn.js");
  dbModule.initDb();
});

/** A queue_items table as it looked before either additive column existed. */
function legacyQueueDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE queue_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', 1, ?)",
  ).run("legacy-1", "s1", "web:legacy", "an already queued prompt", "2026-08-01T00:00:00.000Z");
  return db;
}

function schemaSnapshot(db: Database.Database): unknown {
  return {
    columns: db.prepare("PRAGMA table_info(queue_items)").all(),
    indexes: db.prepare("PRAGMA index_list(queue_items)").all(),
  };
}

function queueRows(sessionId: string): Array<{ id: string; status: string; dedupe_key: string | null }> {
  return dbModule.initDb()
    .prepare("SELECT id, status, dedupe_key FROM queue_items WHERE session_id = ? ORDER BY position ASC")
    .all(sessionId) as Array<{ id: string; status: string; dedupe_key: string | null }>;
}

function turn(session: { id: string; sessionKey: string }, message: string, dedupeKey?: string) {
  return {
    sessionId: session.id,
    sessionKey: session.sessionKey,
    prompt: message,
    isNotification: true,
    role: "notification",
    content: `📨 ${message}`,
    dedupeKey,
  };
}

describe("migrateQueueItemsSchema", () => {
  it("adds dedupe_key and its unique index to a legacy table that already has rows", () => {
    const db = legacyQueueDb();

    migrateQueueItemsSchema(db);

    const columns = db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string; notnull: number }>;
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "internal", notnull: 1 }),
      expect.objectContaining({ name: "dedupe_key", notnull: 0 }),
    ]));
    const indexes = db.prepare("PRAGMA index_list(queue_items)").all() as Array<{ name: string; unique: number; partial: number }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uq_queue_items_dedupe", unique: 1, partial: 1 }),
    ]));
    const legacy = db.prepare("SELECT prompt, dedupe_key FROM queue_items WHERE id = 'legacy-1'").get();
    expect(legacy).toEqual({ prompt: "an already queued prompt", dedupe_key: null });
  });

  it("adds a nullable message_id to a legacy table, leaving its rows readable", () => {
    const db = legacyQueueDb();

    migrateQueueItemsSchema(db);

    const columns = db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string; notnull: number }>;
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "message_id", notnull: 0 }),
    ]));
    expect(db.prepare("SELECT prompt, message_id FROM queue_items WHERE id = 'legacy-1'").get())
      .toEqual({ prompt: "an already queued prompt", message_id: null });
  });

  it("is a no-op the second time it runs on the same DB", () => {
    const db = legacyQueueDb();
    migrateQueueItemsSchema(db);
    const afterFirst = schemaSnapshot(db);

    expect(() => migrateQueueItemsSchema(db)).not.toThrow();

    expect(schemaSnapshot(db)).toEqual(afterFirst);
    expect(db.prepare("SELECT COUNT(*) as count FROM queue_items").get()).toEqual({ count: 1 });
  });
});

describe("claimIncomingTurn — dedupe identity", () => {
  it("writes one queue row and one message for a replayed send, and names the winner", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:dedupe-replay" });
    const key = turns.lateralSendDedupeKey("caller-1", session.id, "status please");

    const first = turns.claimIncomingTurn(turn(session, "status please", key));
    const replay = turns.claimIncomingTurn(turn(session, "status please", key));

    expect(first.deduplicated).toBe(false);
    expect(replay).toEqual({ deduplicated: true, queueItemId: first.queueItemId });
    expect(queueRows(session.id)).toHaveLength(1);
    expect(reg.getMessages(session.id)).toHaveLength(1);
  });

  it("survives a burst of identical claims without leaking a constraint error", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:dedupe-burst" });
    const key = turns.lateralSendDedupeKey("caller-2", session.id, "burst");

    const claims = Array.from({ length: 12 }, () => turns.claimIncomingTurn(turn(session, "burst", key)));

    expect(claims.filter((claim) => !claim.deduplicated)).toHaveLength(1);
    expect(queueRows(session.id)).toHaveLength(1);
    expect(reg.getMessages(session.id)).toHaveLength(1);
  });

  it("binds identity only while the send is unsettled — a later repeat enqueues again", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:dedupe-settled" });
    const key = turns.lateralSendDedupeKey("caller-3", session.id, "ping");
    const first = turns.claimIncomingTurn(turn(session, "ping", key));
    reg.markQueueItemCompleted(first.queueItemId!);

    const later = turns.claimIncomingTurn(turn(session, "ping", key));

    expect(later.deduplicated).toBe(false);
    expect(later.queueItemId).not.toBe(first.queueItemId);
    expect(queueRows(session.id).map((row) => row.status)).toEqual(["completed", "pending"]);
  });

  it("leaves no queue row behind when the message write fails", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:dedupe-rollback" });
    const key = turns.lateralSendDedupeKey("caller-4", session.id, "doomed");

    expect(() => turns.claimIncomingTurn({
      ...turn(session, "doomed", key),
      content: null as unknown as string,
    })).toThrow();

    expect(queueRows(session.id)).toHaveLength(0);
    expect(reg.getMessages(session.id)).toHaveLength(0);
    // The failed claim released its identity: the retry is free to take it.
    expect(turns.claimIncomingTurn(turn(session, "doomed", key)).deduplicated).toBe(false);
  });

  it("does not dedupe a turn that carries no identity", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:dedupe-absent" });

    turns.claimIncomingTurn(turn(session, "operator relay"));
    turns.claimIncomingTurn(turn(session, "operator relay"));

    expect(queueRows(session.id)).toHaveLength(2);
    expect(queueRows(session.id).every((row) => row.dedupe_key === null)).toBe(true);
    expect(reg.getMessages(session.id)).toHaveLength(2);
  });

  it("binds a durable Talk turn after settlement and rejects changed replay input", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:durable-talk" });
    const input = {
      ...turn(session, "keep this approach", "talk:session-1:provider-call-1"),
      role: "user",
      content: "keep this approach",
      queueVisibility: "visible" as const,
      durableDedupe: true,
    };
    const first = turns.claimIncomingTurn(input);
    if (first.deduplicated) throw new Error("the first durable claim unexpectedly replayed");
    reg.markQueueItemCompleted(first.queueItemId!);

    const replay = turns.claimIncomingTurn(input);

    expect(replay).toEqual({
      deduplicated: true,
      queueItemId: first.queueItemId,
      messageId: first.messageId,
    });
    expect(queueRows(session.id)).toHaveLength(1);
    expect(reg.getMessages(session.id).map((message) => message.content)).toEqual(["keep this approach"]);
    expect(() => turns.claimIncomingTurn({ ...input, content: "changed retry", prompt: "changed retry" }))
      .toThrow(/different input|dedupe/i);
  });
});
