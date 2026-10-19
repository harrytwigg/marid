import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { TalkControlSuccess } from "../../control/types.js";
import { TalkSessionRepository, TalkToolReceiptRepository } from "../repository.js";
import { TALK_SESSION_TTL_MS, TalkSessionRegistry } from "../registry.js";
import { migrateTalkSessionSchema } from "../schema.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function repositoryPair() {
  const database = new Database(":memory:");
  databases.push(database);
  migrateTalkSessionSchema(database);
  return {
    database,
    sessions: new TalkSessionRepository(database),
    receipts: new TalkToolReceiptRepository(database),
  };
}

function clockAt(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

describe("TalkSessionRepository", () => {
  it("reloads exact recoverable state through a fresh registry", () => {
    const { database, sessions } = repositoryPair();
    const clock = clockAt();
    const first = new TalkSessionRegistry(clock.now, sessions);
    const opened = first.open({
      sessionId: "chat-row-1",
      model: "realtime-model",
      brief: "Neutral operator brief",
      tokenExpiresAt: 1_700_000_600,
      browserInstanceId: "browser-one",
    });
    first.appendTurn(opened.id, "Keep the launch decision", 8_000, [{
      requestKey: "visual-gap-1",
      contextRevision: 4,
      reason: "workflow-layout",
      bytes: 1200,
      width: 800,
      height: 600,
      estimatedImageTokens: 220,
      latencyMs: 15,
    }]);
    first.recordAction(opened.id, {
      tool: "comment_work_item",
      subject: "TSK-42",
      lane: "fast",
      consent: "not-required",
    });
    first.recordToken(opened.id, 1_700_000_900);
    first.park(opened.id);

    const reloaded = new TalkSessionRegistry(clock.now, new TalkSessionRepository(database));
    expect(reloaded.get(opened.id)).toEqual(first.get(opened.id));
    expect(reloaded.get(opened.id)).toMatchObject({
      state: "parked",
      credentialGeneration: 2,
      turns: [{ text: "Keep the launch decision" }],
      actions: [{ tool: "comment_work_item", subject: "TSK-42" }],
      visualReceiptKeys: ["visual-gap-1:4:workflow-layout"],
    });
  });

  it("keeps a closed row and its history without exposing it as resumable", () => {
    const { sessions } = repositoryPair();
    const registry = new TalkSessionRegistry(Date.now, sessions);
    const opened = registry.open({ sessionId: "chat-row-2", model: "realtime-model", brief: "", tokenExpiresAt: 2 });
    registry.appendTurn(opened.id, "Durable question");
    registry.close(opened.id);

    expect(registry.get(opened.id)).toBeUndefined();
    expect(sessions.get(opened.id, { includeClosed: true })).toMatchObject({
      state: "closed",
      turns: [{ text: "Durable question" }],
    });
  });

  it("parks stale live rows durably while leaving parked rows recoverable", () => {
    const { database, sessions } = repositoryPair();
    const clock = clockAt();
    const first = new TalkSessionRegistry(clock.now, sessions);
    const opened = first.open({ sessionId: "chat-row-3", model: "realtime-model", brief: "", tokenExpiresAt: 2 });
    clock.advance(TALK_SESSION_TTL_MS + 1);

    expect(first.reap()).toEqual([opened.id]);
    const reloaded = new TalkSessionRegistry(clock.now, new TalkSessionRepository(database));
    expect(reloaded.reap()).toEqual([]);
    expect(reloaded.resume(opened.id).state).toBe("live");
  });

  it("reloads content-free interruption telemetry through a fresh registry", () => {
    const { database, sessions } = repositoryPair();
    const clock = clockAt();
    const first = new TalkSessionRegistry(clock.now, sessions);
    const opened = first.open({ sessionId: "chat-row-4", model: "realtime-model", brief: "", tokenExpiresAt: 2 });

    first.recordInterruption(opened.id, {
      kind: "speech_interruption",
      vadType: "semantic_vad",
      cancelledBy: "provider",
      recovered: true,
      speechMs: 240,
    });

    const reloaded = new TalkSessionRegistry(clock.now, new TalkSessionRepository(database));
    expect(reloaded.get(opened.id)?.interruptions).toEqual([{
      at: 1_000_000,
      kind: "speech_interruption",
      vadType: "semantic_vad",
      cancelledBy: "provider",
      recovered: true,
      speechMs: 240,
    }]);
  });
});

describe("TalkToolReceiptRepository", () => {
  const result: TalkControlSuccess = {
    ok: true,
    receiptId: "receipt-one",
    replayed: false,
    verified: true,
    operation: "comment_work_item",
    data: { commentId: "comment-one" },
    evidence: { commentId: "comment-one" },
    uiEffect: { invalidate: ["work-items"] },
  };

  it("persists a verified result for replay through a fresh repository", () => {
    const { database, receipts } = repositoryPair();
    expect(receipts.put({
      talkSessionId: "talk-one",
      providerCallId: "call-one",
      requestFingerprint: "fingerprint-one",
      result,
      createdAt: 123,
    }).status).toBe("stored");

    const reloaded = new TalkToolReceiptRepository(database);
    expect(reloaded.get("talk-one", "call-one")).toEqual({
      talkSessionId: "talk-one",
      providerCallId: "call-one",
      requestFingerprint: "fingerprint-one",
      result,
      createdAt: 123,
    });
    expect(reloaded.put({
      talkSessionId: "talk-one",
      providerCallId: "call-one",
      requestFingerprint: "fingerprint-one",
      result,
      createdAt: 456,
    }).status).toBe("replayed");
  });

  it("reports a provider-call conflict without replacing the first result", () => {
    const { receipts } = repositoryPair();
    receipts.put({ talkSessionId: "talk-one", providerCallId: "call-one", requestFingerprint: "first", result, createdAt: 1 });
    const conflict = receipts.put({ talkSessionId: "talk-one", providerCallId: "call-one", requestFingerprint: "changed", result, createdAt: 2 });

    expect(conflict.status).toBe("conflict");
    expect(receipts.get("talk-one", "call-one")?.requestFingerprint).toBe("first");
  });
});
