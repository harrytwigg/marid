import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TalkApprovalRepository } from "../repository.js";
import { migrateTalkApprovalSchema } from "../schema.js";

describe("Talk approval schema", () => {
  it("migrates idempotently and keeps provider evidence unique across reopen", () => {
    const db = new Database(":memory:");
    migrateTalkApprovalSchema(db);
    migrateTalkApprovalSchema(db);
    const repository = new TalkApprovalRepository(db);
    const input = {
      talkSessionId: "talk-1", browserInstanceId: "browser-1", credentialGeneration: 1,
      providerItemId: "item-1", providerEventId: "event-1", transcript: "approve", recordedAt: 1,
    };
    expect(repository.recordTranscript(input).inputOrdinal).toBe(1);
    expect(new TalkApprovalRepository(db).recordTranscript(input).inputOrdinal).toBe(1);
    expect(() => repository.recordTranscript({ ...input, providerItemId: "item-2" }))
      .toThrow(/event was reused/);
  });
});
