import { describe, expect, it } from "vitest";
import { resolveTopicReference } from "../resolver.js";
import type { TalkTopic } from "../types.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 18, 12);

function topic(index: number, overrides: Partial<TalkTopic> = {}): TalkTopic {
  const kind = (["chat", "todo", "workflow"] as const)[index % 3]!;
  return {
    id: `topic-${index + 1}`,
    talkSessionId: "talk-1",
    ordinal: index + 1,
    kind,
    state: index < 3 ? "active" : "warm",
    label: `${kind} ${index + 1}`,
    objectAnchors: [{ kind, id: `${kind}-${index + 1}` }],
    goal: `Complete goal ${index + 1}`,
    verifiedState: `State ${index + 1}`,
    decisions: [],
    unresolvedQuestions: [],
    retrievalAnchors: [`/${kind}s/${index + 1}`],
    rawDetails: [`detail ${index + 1}`],
    transient: false,
    createdAt: NOW - index * 1_000,
    updatedAt: NOW - index * 1_000,
    closedAt: null,
    revision: 1,
    ...overrides,
  };
}

function twelveTopics(): TalkTopic[] {
  return Array.from({ length: 12 }, (_, index) => topic(index));
}

describe("resolveTopicReference", () => {
  it("resolves explicit ids and the current screen anchor", () => {
    const topics = twelveTopics();
    expect(resolveTopicReference({ reference: "open todo-5", topics, now: NOW })).toMatchObject({
      status: "resolved", topic: { id: "topic-5" }, reason: "explicit-anchor",
    });
    expect(resolveTopicReference({ reference: "this one", topics, currentTopicId: "topic-9", now: NOW })).toMatchObject({
      status: "resolved", topic: { id: "topic-9" }, reason: "current",
    });
    expect(resolveTopicReference({ reference: "open topic-10", topics, now: NOW })).toMatchObject({
      status: "resolved", topic: { id: "topic-10" }, reason: "explicit-anchor",
    });
  });

  it("uses history and prior candidates for go back, first one, and other one", () => {
    const topics = twelveTopics();
    const context = {
      topics,
      currentTopicId: "topic-8",
      navigationHistory: ["topic-2", "topic-5", "topic-8"],
      lastCandidateIds: ["topic-3", "topic-8"],
      now: NOW,
    };
    expect(resolveTopicReference({ ...context, reference: "go back" })).toMatchObject({ topic: { id: "topic-5" } });
    expect(resolveTopicReference({ ...context, reference: "go back to the first one" })).toMatchObject({ topic: { id: "topic-2" } });
    expect(resolveTopicReference({ ...context, reference: "the other one" })).toMatchObject({ topic: { id: "topic-3" } });
    expect(resolveTopicReference({ ...context, reference: "the first one" })).toMatchObject({ topic: { id: "topic-3" } });
  });

  it("combines date, label, and active-work evidence", () => {
    const topics = twelveTopics();
    topics[9] = topic(9, { label: "Release readiness", state: "active", updatedAt: NOW - DAY });
    topics[10] = topic(10, { label: "Release notes", state: "closed", updatedAt: NOW - 8 * DAY, closedAt: NOW - 7 * DAY });

    expect(resolveTopicReference({ reference: "the release thing from yesterday", topics, now: NOW })).toMatchObject({
      status: "resolved", topic: { id: "topic-10" },
    });
    expect(resolveTopicReference({ reference: "release active work", topics, now: NOW })).toMatchObject({
      status: "resolved", topic: { id: "topic-10" },
    });
  });

  it("returns short honest candidates for an equal match and none below threshold", () => {
    const topics = twelveTopics();
    topics[3] = topic(3, { label: "Blocked launch review" });
    topics[4] = topic(4, { label: "Blocked launch review" });

    const ambiguous = resolveTopicReference({ reference: "blocked launch review", topics, now: NOW });
    expect(ambiguous).toMatchObject({ status: "ambiguous", reason: "multiple-matches" });
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.candidates.map((candidate) => candidate.id)).toEqual(["topic-4", "topic-5"]);
      expect(ambiguous.candidates).toHaveLength(2);
    }
    expect(resolveTopicReference({ reference: "quarterly tax filing", topics, now: NOW })).toEqual({
      status: "none", reason: "below-threshold",
    });
  });
});
