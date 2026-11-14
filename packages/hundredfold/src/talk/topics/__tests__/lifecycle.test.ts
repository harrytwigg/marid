import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TalkTopicLifecycle } from "../lifecycle.js";
import { TalkTopicRepository } from "../repository.js";

function screen(index: number) {
  return {
    credentialGeneration: 1,
    revision: index,
    routeId: index % 3 === 0 ? "workflow" : index % 2 === 0 ? "todo" : "chat",
    path: `/surface/${index}`,
    title: `Surface ${index}`,
    freshness: "complete" as const,
    meaningfulText: `Verified state ${index}`,
    selectedObject: { kind: index % 3 === 0 ? "workflow" : index % 2 === 0 ? "Todo" : "chat session",
      id: `object-${index}`, title: `Topic ${index}`, status: "active", retrievalAnchor: { id: `object-${index}` } },
  };
}

describe("TalkTopicLifecycle", () => {
  it("keeps twelve navigated topics and returns to the first after reconstruction", () => {
    const database = new Database(":memory:");
    const repository = new TalkTopicRepository(database);
    const lifecycle = new TalkTopicLifecycle(repository, () => 1_000);
    const first = lifecycle.observe("talk-1", screen(1));
    for (let index = 2; index <= 12; index += 1) lifecycle.observe("talk-1", screen(index));

    expect(repository.list("talk-1")).toHaveLength(12);
    const rebuilt = new TalkTopicLifecycle(new TalkTopicRepository(database), () => 2_000);
    expect(rebuilt.resolve("talk-1", "go back to the first")).toMatchObject({ status: "resolved", topic: { id: first.id } });
    database.close();
  });

  it("persists decisions and questions while the topic cools", () => {
    const database = new Database(":memory:");
    const repository = new TalkTopicRepository(database);
    const lifecycle = new TalkTopicLifecycle(repository, () => 1_000);
    const first = lifecycle.observe("talk-1", screen(1));
    lifecycle.remember("talk-1", { goal: "Ship safely", decision: "Keep the staged rollout", unresolvedQuestion: "Who verifies it?" });
    for (let index = 2; index <= 12; index += 1) lifecycle.observe("talk-1", screen(index));

    expect(repository.get(first.id)).toMatchObject({
      goal: "Ship safely",
      decisions: ["Keep the staged rollout"],
      unresolvedQuestions: ["Who verifies it?"],
    });
    database.close();
  });

  it("ignores an out-of-order screen revision but accepts a fresh credential generation", () => {
    const database = new Database(":memory:");
    const repository = new TalkTopicRepository(database);
    const lifecycle = new TalkTopicLifecycle(repository, () => 1_000);
    const current = lifecycle.observe("talk-1", { ...screen(2), revision: 8 });

    expect(lifecycle.observe("talk-1", { ...screen(1), revision: 7 }).id).toBe(current.id);
    expect(lifecycle.observe("talk-1", { ...screen(1), credentialGeneration: 2, revision: 1 }).id).not.toBe(current.id);
    database.close();
  });
});
