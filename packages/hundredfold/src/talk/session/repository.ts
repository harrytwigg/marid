import type { Database } from "better-sqlite3";
import type { TalkControlReceipt, TalkControlReceiptStore } from "../control/types.js";
import type {
  TalkActionRecord,
  TalkInterruptionRecord,
  TalkSession,
  TalkSessionReadOptions,
  TalkSessionStore,
  TalkTurnRecord,
  VisualCaptureReceipt,
} from "./types.js";

type Row = Record<string, unknown>;

function parseArray<T>(value: unknown): T[] {
  const parsed = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored Talk session JSON is not an array.");
  return parsed as T[];
}

function turnFromRow(row: Row): TalkTurnRecord {
  const receipts = parseArray<VisualCaptureReceipt>(row.visual_receipts_json);
  return {
    at: Number(row.at),
    text: String(row.text),
    estimatedTokens: Number(row.estimated_tokens),
    ...(receipts.length > 0 ? { visualReceipts: receipts } : {}),
  };
}

function actionFromRow(row: Row): TalkActionRecord {
  return {
    id: String(row.id),
    at: Number(row.at),
    tool: String(row.tool),
    subject: row.subject === null ? null : String(row.subject),
    lane: row.lane as TalkActionRecord["lane"],
    consent: row.consent as TalkActionRecord["consent"],
    ...(row.undo_of === null ? {} : { undoOf: String(row.undo_of) }),
  };
}

function interruptionFromRow(row: Row): TalkInterruptionRecord {
  return {
    at: Number(row.at),
    kind: row.kind as TalkInterruptionRecord["kind"],
    vadType: row.vad_type as TalkInterruptionRecord["vadType"],
    cancelledBy: row.cancelled_by as TalkInterruptionRecord["cancelledBy"],
    recovered: Number(row.recovered) === 1,
    speechMs: row.speech_ms === null ? null : Number(row.speech_ms),
  };
}

export class TalkSessionRepository implements TalkSessionStore {
  constructor(private readonly database: Database) {}

  get(id: string, options: TalkSessionReadOptions = {}): TalkSession | undefined {
    const row = this.database.prepare(`SELECT * FROM talk_sessions WHERE id = ?${options.includeClosed ? "" : " AND state != 'closed'"}`)
      .get(id) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(options: TalkSessionReadOptions = {}): TalkSession[] {
    const rows = this.database.prepare(`SELECT * FROM talk_sessions${options.includeClosed ? "" : " WHERE state != 'closed'"} ORDER BY opened_at, id`)
      .all() as Row[];
    return rows.map((row) => this.hydrate(row));
  }

  save(session: TalkSession): void {
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO talk_sessions
        (id, browser_instance_id, credential_generation, session_id, state, model, brief, opened_at,
         last_seen_at, truncated_turns, token_expires_at, exposed_tools_json, expanded_intents_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET browser_instance_id = excluded.browser_instance_id,
          credential_generation = excluded.credential_generation, session_id = excluded.session_id,
          state = excluded.state, model = excluded.model, brief = excluded.brief,
          opened_at = excluded.opened_at, last_seen_at = excluded.last_seen_at,
          truncated_turns = excluded.truncated_turns, token_expires_at = excluded.token_expires_at,
          exposed_tools_json = excluded.exposed_tools_json, expanded_intents_json = excluded.expanded_intents_json`)
        .run(session.id, session.browserInstanceId, session.credentialGeneration, session.sessionId,
          session.state, session.model, session.brief, session.openedAt, session.lastSeenAt,
          session.truncatedTurns, session.tokenExpiresAt, JSON.stringify(session.exposedTools),
          "[]");

      this.replaceChildren(session);
    })();
  }

  private replaceChildren(session: TalkSession): void {
    this.database.prepare("DELETE FROM talk_session_turns WHERE talk_session_id = ?").run(session.id);
    this.database.prepare("DELETE FROM talk_session_actions WHERE talk_session_id = ?").run(session.id);
    this.database.prepare("DELETE FROM talk_session_interruptions WHERE talk_session_id = ?").run(session.id);
    this.database.prepare("DELETE FROM talk_session_visual_receipt_keys WHERE talk_session_id = ?").run(session.id);
    const turn = this.database.prepare(`INSERT INTO talk_session_turns
      (talk_session_id, ordinal, at, text, estimated_tokens, visual_receipts_json) VALUES (?, ?, ?, ?, ?, ?)`);
    session.turns.forEach((item, index) => turn.run(session.id, index + 1, item.at, item.text,
      item.estimatedTokens, JSON.stringify(item.visualReceipts ?? [])));
    const action = this.database.prepare(`INSERT INTO talk_session_actions
      (talk_session_id, ordinal, id, at, tool, subject, lane, consent, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    session.actions.forEach((item, index) => action.run(session.id, index + 1, item.id, item.at,
      item.tool, item.subject, item.lane, item.consent, item.undoOf ?? null));
    const interruption = this.database.prepare(`INSERT INTO talk_session_interruptions
      (talk_session_id, ordinal, at, kind, vad_type, cancelled_by, recovered, speech_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    (session.interruptions ?? []).forEach((item, index) => interruption.run(session.id, index + 1,
      item.at, item.kind, item.vadType, item.cancelledBy, item.recovered ? 1 : 0, item.speechMs));
    const visualKey = this.database.prepare(`INSERT INTO talk_session_visual_receipt_keys
      (talk_session_id, ordinal, receipt_key) VALUES (?, ?, ?)`);
    session.visualReceiptKeys.forEach((key, index) => visualKey.run(session.id, index + 1, key));
  }

  private hydrate(row: Row): TalkSession {
    const id = String(row.id);
    const turns = this.database.prepare("SELECT * FROM talk_session_turns WHERE talk_session_id = ? ORDER BY ordinal")
      .all(id) as Row[];
    const actions = this.database.prepare("SELECT * FROM talk_session_actions WHERE talk_session_id = ? ORDER BY ordinal")
      .all(id) as Row[];
    const interruptions = this.database.prepare("SELECT * FROM talk_session_interruptions WHERE talk_session_id = ? ORDER BY ordinal")
      .all(id) as Row[];
    const keys = this.database.prepare("SELECT receipt_key FROM talk_session_visual_receipt_keys WHERE talk_session_id = ? ORDER BY ordinal")
      .all(id) as Array<{ receipt_key: string }>;
    return {
      id,
      browserInstanceId: String(row.browser_instance_id),
      credentialGeneration: Number(row.credential_generation),
      sessionId: String(row.session_id),
      state: row.state as TalkSession["state"],
      model: String(row.model),
      brief: String(row.brief),
      openedAt: Number(row.opened_at),
      lastSeenAt: Number(row.last_seen_at),
      turns: turns.map(turnFromRow),
      truncatedTurns: Number(row.truncated_turns),
      tokenExpiresAt: Number(row.token_expires_at),
      exposedTools: parseArray<string>(row.exposed_tools_json),
      actions: actions.map(actionFromRow),
      interruptions: interruptions.map(interruptionFromRow),
      visualReceiptKeys: keys.map(({ receipt_key }) => receipt_key),
    };
  }
}

export type TalkToolReceiptPutResult =
  | { status: "stored" | "replayed"; receipt: TalkControlReceipt }
  | { status: "conflict"; receipt: TalkControlReceipt };

export class TalkToolReceiptRepository implements TalkControlReceiptStore {
  constructor(private readonly database: Database) {}

  get(talkSessionId: string, providerCallId: string): TalkControlReceipt | null {
    const row = this.database.prepare(`SELECT * FROM talk_tool_receipts
      WHERE talk_session_id = ? AND provider_call_id = ?`).get(talkSessionId, providerCallId) as Row | undefined;
    return row ? {
      talkSessionId: String(row.talk_session_id),
      providerCallId: String(row.provider_call_id),
      requestFingerprint: String(row.request_fingerprint),
      result: JSON.parse(String(row.result_json)) as TalkControlReceipt["result"],
      createdAt: Number(row.created_at),
    } : null;
  }

  put(input: TalkControlReceipt): TalkToolReceiptPutResult {
    const inserted = this.database.prepare(`INSERT OR IGNORE INTO talk_tool_receipts
      (talk_session_id, provider_call_id, request_fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.talkSessionId, input.providerCallId, input.requestFingerprint, JSON.stringify(input.result), input.createdAt);
    if (inserted.changes === 1) return { status: "stored", receipt: input };
    const receipt = this.get(input.talkSessionId, input.providerCallId)!;
    return receipt.requestFingerprint === input.requestFingerprint
      ? { status: "replayed", receipt }
      : { status: "conflict", receipt };
  }
}
