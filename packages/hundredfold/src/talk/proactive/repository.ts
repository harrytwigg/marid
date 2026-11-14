import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ProactiveDecision, ProactiveInterruptionState, ProactiveReceipt, ProactiveSignal } from "./types.js";
import { proactiveDedupeIdentity, proactiveEventIdentity } from "./dedupe.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS talk_proactive_receipts (
  id TEXT PRIMARY KEY,
  talk_session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  topic_id TEXT,
  urgency TEXT NOT NULL CHECK (urgency IN ('routine', 'urgent')),
  disposition TEXT NOT NULL CHECK (disposition IN ('ignore', 'quiet', 'spoken')),
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  ui_effect_json TEXT CHECK (ui_effect_json IS NULL OR json_valid(ui_effect_json)),
  status TEXT NOT NULL CHECK (status IN ('ignored', 'delivering', 'retryable', 'delivered', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  interruption_state TEXT NOT NULL CHECK (interruption_state IN ('none', 'requested', 'completed', 'interrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  acknowledged_at INTEGER,
  next_attempt_at INTEGER,
  lease_until INTEGER,
  last_error TEXT,
  UNIQUE (talk_session_id, event_id),
  UNIQUE (talk_session_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_talk_proactive_delivery
  ON talk_proactive_receipts (talk_session_id, status, next_attempt_at);
`;

type Row = Record<string, unknown>;
type ClaimResult = {
  kind: "deliver" | "ignored" | "replayed" | "deferred" | "in-flight";
  receipt: ProactiveReceipt;
};

function fromRow(row: Row): ProactiveReceipt {
  return {
    id: String(row.id), talkSessionId: String(row.talk_session_id), eventId: String(row.event_id),
    dedupeKey: String(row.dedupe_key), topicId: row.topic_id === null ? null : String(row.topic_id),
    urgency: row.urgency as ProactiveReceipt["urgency"], disposition: row.disposition as ProactiveReceipt["disposition"],
    reason: String(row.reason), summary: String(row.summary),
    uiEffect: row.ui_effect_json === null ? null : JSON.parse(String(row.ui_effect_json)) as ProactiveReceipt["uiEffect"],
    status: row.status as ProactiveReceipt["status"], attempts: Number(row.attempts),
    interruptionState: row.interruption_state as ProactiveReceipt["interruptionState"],
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

export function migrateTalkProactiveSchema(database: Database): void {
  database.exec(SCHEMA);
  const columns = database.pragma("table_info(talk_proactive_receipts)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "acknowledged_at")) {
    database.exec("ALTER TABLE talk_proactive_receipts ADD COLUMN acknowledged_at INTEGER");
  }
}

export class TalkProactiveRepository {
  constructor(private readonly database: Database) { migrateTalkProactiveSchema(database); }

  get(id: string): ProactiveReceipt | null {
    const row = this.database.prepare("SELECT * FROM talk_proactive_receipts WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(talkSessionId: string): ProactiveReceipt[] {
    return (this.database.prepare("SELECT * FROM talk_proactive_receipts WHERE talk_session_id = ? ORDER BY created_at, id")
      .all(talkSessionId) as Row[]).map(fromRow);
  }

  pending(talkSessionId: string): ProactiveReceipt[] {
    return (this.database.prepare(`SELECT * FROM talk_proactive_receipts WHERE talk_session_id = ?
      AND status = 'delivered' AND acknowledged_at IS NULL ORDER BY delivered_at, id`).all(talkSessionId) as Row[]).map(fromRow);
  }

  latestSpokenAt(talkSessionId: string): number | null {
    const row = this.database.prepare(`SELECT MAX(delivered_at) AS delivered_at FROM talk_proactive_receipts
      WHERE talk_session_id = ? AND disposition = 'spoken' AND status = 'delivered'`).get(talkSessionId) as Row;
    return row.delivered_at === null ? null : Number(row.delivered_at);
  }

  claim(signal: ProactiveSignal, decision: ProactiveDecision, now: number, leaseMs: number, maxAttempts: number): ClaimResult {
    return this.database.transaction((): ClaimResult => {
      const existing = this.byIdentity(signal);
      if (existing) return this.reclaim(existing, now, leaseMs, maxAttempts);
      const ignored = decision.disposition === "ignore";
      const id = randomUUID();
      this.database.prepare(`INSERT INTO talk_proactive_receipts
        (id, talk_session_id, event_id, dedupe_key, topic_id, urgency, disposition, reason, summary, ui_effect_json,
         status, attempts, interruption_state, created_at, updated_at, lease_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?)`)
        .run(id, signal.talkSessionId, proactiveEventIdentity(signal), proactiveDedupeIdentity(signal), signal.topicId,
          decision.urgency, decision.disposition, decision.reason, signal.summary,
          signal.uiEffect === null ? null : JSON.stringify(signal.uiEffect), ignored ? "ignored" : "delivering",
          ignored ? 0 : 1, now, now, ignored ? null : now + leaseMs);
      return { kind: ignored ? "ignored" : "deliver", receipt: this.get(id)! };
    })();
  }

  private byIdentity(signal: ProactiveSignal): ProactiveReceipt | null {
    const row = this.database.prepare(`SELECT * FROM talk_proactive_receipts WHERE talk_session_id = ?
      AND (event_id = ? OR dedupe_key = ?) LIMIT 1`)
      .get(signal.talkSessionId, proactiveEventIdentity(signal), proactiveDedupeIdentity(signal)) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  private reclaim(receipt: ProactiveReceipt, now: number, leaseMs: number, maxAttempts: number): {
    kind: "deliver" | "replayed" | "deferred" | "in-flight"; receipt: ProactiveReceipt;
  } {
    if (["delivered", "ignored", "failed"].includes(receipt.status)) return { kind: "replayed", receipt };
    if (receipt.status === "delivering" && (receipt.leaseUntil ?? 0) > now) return { kind: "in-flight", receipt };
    if (receipt.status === "retryable" && (receipt.nextAttemptAt ?? 0) > now) return { kind: "deferred", receipt };
    if (receipt.attempts >= maxAttempts) {
      this.database.prepare("UPDATE talk_proactive_receipts SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(now, receipt.id);
      return { kind: "replayed", receipt: this.get(receipt.id)! };
    }
    this.database.prepare(`UPDATE talk_proactive_receipts SET status = 'delivering', attempts = attempts + 1,
      updated_at = ?, lease_until = ?, next_attempt_at = NULL WHERE id = ?`).run(now, now + leaseMs, receipt.id);
    return { kind: "deliver", receipt: this.get(receipt.id)! };
  }

  markDelivered(id: string, now: number): ProactiveReceipt {
    this.database.prepare(`UPDATE talk_proactive_receipts SET status = 'delivered', delivered_at = ?, updated_at = ?,
      lease_until = NULL, next_attempt_at = NULL, last_error = NULL,
      interruption_state = CASE WHEN disposition = 'spoken' THEN 'requested' ELSE 'none' END WHERE id = ?`)
      .run(now, now, id);
    return this.get(id)!;
  }

  markFailure(id: string, error: string, now: number, maxAttempts: number, retryDelayMs: number): ProactiveReceipt {
    const receipt = this.get(id)!;
    const terminal = receipt.attempts >= maxAttempts;
    this.database.prepare(`UPDATE talk_proactive_receipts SET status = ?, updated_at = ?, lease_until = NULL,
      next_attempt_at = ?, last_error = ? WHERE id = ?`)
      .run(terminal ? "failed" : "retryable", now, terminal ? null : now + retryDelayMs, error.slice(0, 500), id);
    return this.get(id)!;
  }

  recordInterruption(id: string, state: Extract<ProactiveInterruptionState, "completed" | "interrupted">, now: number): ProactiveReceipt {
    const current = this.get(id);
    if (!current) throw new Error(`Proactive receipt ${id} does not exist.`);
    if (current.disposition !== "spoken") throw new Error("Only a spoken proactive cue has interruption state.");
    if (current.interruptionState === "requested") {
      this.database.prepare("UPDATE talk_proactive_receipts SET interruption_state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, id);
    }
    return this.get(id)!;
  }

  acknowledge(
    talkSessionId: string,
    id: string,
    state: Extract<ProactiveInterruptionState, "completed" | "interrupted">,
    now: number,
  ): ProactiveReceipt {
    const current = this.get(id);
    if (!current || current.talkSessionId !== talkSessionId) throw new Error("The proactive receipt does not belong to this Talk session.");
    if (current.acknowledgedAt !== null) return current;
    if (current.disposition === "spoken") this.recordInterruption(id, state, now);
    this.database.prepare("UPDATE talk_proactive_receipts SET acknowledged_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    return this.get(id)!;
  }
}
