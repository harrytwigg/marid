import { describe, expect, it } from "vitest";
import { collectTopicGarbage } from "../garbage-collector.js";
import { rehydrateTopic } from "../rehydrate.js";
import { measureTopicContext } from "../telemetry.js";
import type { TalkTopic } from "../types.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 18);

function topic(index: number, overrides: Partial<TalkTopic> = {}): TalkTopic {
  return {
    id: `topic-${index}`,
    talkSessionId: "talk-1",
    ordinal: index,
    kind: "todo",
    state: "warm",
    label: `Topic ${index}`,
    objectAnchors: [{ kind: "todo", id: `todo-${index}` }],
    goal: `Goal ${index}`,
    verifiedState: `State ${index}`,
    decisions: [`Decision ${index}`],
    unresolvedQuestions: [],
    retrievalAnchors: [`/todos/todo-${index}`],
    rawDetails: [`raw ${index}.1`, `raw ${index}.2`],
    transient: false,
    createdAt: NOW - index * DAY,
    updatedAt: NOW - index * DAY,
    closedAt: null,
    revision: 1,
    ...overrides,
  };
}

describe("collectTopicGarbage", () => {
  it("bounds raw detail while keeping current, active, and unresolved topics warm", () => {
    const topics = Array.from({ length: 12 }, (_, index) => topic(index));
    topics[3] = topic(3, { state: "active" });
    topics[9] = topic(9, { unresolvedQuestions: ["Who owns the next step?"] });

    const result = collectTopicGarbage(topics, {
      currentTopicId: "topic-7", now: NOW, maxWarmTopics: 4, rawDetailItemBudget: 6, closedRetentionMs: 5 * DAY,
    });

    expect(result.topics.flatMap((entry) => entry.rawDetails)).toHaveLength(6);
    for (const id of ["topic-3", "topic-7", "topic-9"]) {
      expect(result.topics.find((entry) => entry.id === id)?.state).not.toBe("cool");
    }
    expect(result.stats.compactedTopics).toBeGreaterThan(0);
    expect(result.topics).toHaveLength(12);
  });

  it("compacts raw detail before commitments and expires only old closed transient noise", () => {
    const committed = topic(8, { state: "closed", closedAt: NOW - 20 * DAY });
    const noise = topic(10, {
      state: "closed", transient: true, goal: "", decisions: [], retrievalAnchors: [], closedAt: NOW - 20 * DAY,
    });
    const recentNoise = topic(11, { state: "closed", transient: true, closedAt: NOW - DAY });
    const result = collectTopicGarbage([committed, noise, recentNoise], {
      now: NOW, maxWarmTopics: 1, rawDetailItemBudget: 0, closedRetentionMs: 5 * DAY,
    });

    expect(result.expiredIds).toEqual(["topic-10"]);
    expect(result.topics.find((entry) => entry.id === "topic-8")).toMatchObject({
      goal: committed.goal,
      verifiedState: committed.verifiedState,
      decisions: committed.decisions,
      retrievalAnchors: committed.retrievalAnchors,
      rawDetails: [],
    });
    expect(result.topics.some((entry) => entry.id === "topic-11")).toBe(true);
  });
});

describe("topic rehydration and telemetry", () => {
  it("refreshes live state from a retrieval anchor without losing commitments", async () => {
    const cooled = topic(5, { state: "cool", rawDetails: [] });
    const refreshed = await rehydrateTopic(cooled, async (anchors) => {
      expect(anchors).toEqual(["/todos/todo-5"]);
      return { verifiedState: "In review", rawDetails: ["The reviewer is assigned"] };
    }, NOW);

    expect(refreshed).toMatchObject({
      state: "warm",
      verifiedState: "In review",
      goal: cooled.goal,
      decisions: cooled.decisions,
      unresolvedQuestions: cooled.unresolvedQuestions,
      rawDetails: ["The reviewer is assigned"],
      updatedAt: NOW,
      revision: 2,
    });
  });

  it("reports lifecycle counts and a bounded context estimate", () => {
    const telemetry = measureTopicContext([
      topic(1, { state: "active" }), topic(2), topic(3, { state: "cool", rawDetails: [] }),
      topic(4, { state: "closed", closedAt: NOW }),
    ]);
    expect(telemetry).toMatchObject({ active: 1, warm: 1, cool: 1, closed: 1, rawDetailItems: 6 });
    expect(telemetry.estimatedTokens).toBeGreaterThan(0);
  });
});
