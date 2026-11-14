import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../shared/gateway-events.js";
import { migrateTalkSessionSchema } from "../../talk/session/schema.js";
import { TalkSessionRepository } from "../../talk/session/repository.js";
import type { TalkSession } from "../../talk/session/types.js";
import { TalkTopicRepository } from "../../talk/topics/repository.js";
import type { TalkTopic } from "../../talk/topics/types.js";
import { createTalkProactiveGatewayEmit } from "../talk-proactive-events.js";

const NOW = 1_800_000_000_000;

function seed(database: Database.Database, anchor: { kind: string; id: string }): void {
  migrateTalkSessionSchema(database);
  const session: TalkSession = {
    id: "talk-1", browserInstanceId: "browser-1", credentialGeneration: 1, sessionId: "chat-ledger-1",
    state: "live", model: "realtime", brief: "brief", openedAt: NOW, lastSeenAt: NOW, turns: [],
    truncatedTurns: 0, tokenExpiresAt: NOW + 60_000, exposedTools: [], actions: [], visualReceiptKeys: [],
  };
  new TalkSessionRepository(database).save(session);
  const topic: TalkTopic = {
    id: "topic-1", talkSessionId: session.id, ordinal: 1, kind: "todo", state: "active", label: "Launch task",
    objectAnchors: [anchor], goal: "Ship safely", verifiedState: "Open", decisions: [], unresolvedQuestions: [],
    retrievalAnchors: ["route:/todos"], rawDetails: [], transient: false, createdAt: NOW, updatedAt: NOW,
    closedAt: null, revision: 1,
  };
  new TalkTopicRepository(database).put(topic);
}

describe("createTalkProactiveGatewayEmit", () => {
  it("broadcasts one canonical quiet cue for duplicate related Todo changes", () => {
    const database = new Database(":memory:");
    seed(database, { kind: "todo", id: "todo-1" });
    const frames: GatewayEvent[] = [];
    const emit = createTalkProactiveGatewayEmit(database, (event, payload) => frames.push({ event, payload } as GatewayEvent), () => NOW);
    const payload = { entity: "todo" as const, action: "updated", id: "todo-1", version: 2 };
    emit("company:changed", payload);
    emit("company:changed", payload);

    expect(frames.filter((frame) => frame.event === "company:changed")).toHaveLength(2);
    expect(frames.filter((frame) => frame.event === "talk:proactive-cue")).toHaveLength(1);
    expect(frames.find((frame) => frame.event === "talk:proactive-cue")?.payload).toMatchObject({
      talkSessionId: "talk-1", topicId: "topic-1", disposition: "quiet", urgency: "routine",
    });
    database.close();
  });

  it("speaks a related failed chat but emits no unanchored employee noise", () => {
    const database = new Database(":memory:");
    seed(database, { kind: "chat", id: "chat-1" });
    const frames: GatewayEvent[] = [];
    const emit = createTalkProactiveGatewayEmit(database, (event, payload) => frames.push({ event, payload } as GatewayEvent), () => NOW);
    emit("session:completed", { sessionId: "other-chat", result: "Done", error: null, employee: "worker" });
    emit("session:completed", { sessionId: "chat-1", result: null, error: "failed", employee: "worker" });

    const cues = frames.filter((frame) => frame.event === "talk:proactive-cue");
    expect(cues).toHaveLength(1);
    expect(cues[0]?.payload).toMatchObject({ disposition: "spoken", urgency: "urgent", summary: "A related chat failed." });
    database.close();
  });
});
