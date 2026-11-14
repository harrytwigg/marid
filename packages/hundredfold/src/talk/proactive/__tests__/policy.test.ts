import { describe, expect, it } from "vitest";
import { decideProactiveDisposition } from "../policy.js";
import type { ProactiveSignal } from "../types.js";

const NOW = 1_800_000_000_000;

function signal(overrides: Partial<ProactiveSignal> = {}): ProactiveSignal {
  return {
    eventId: "event-1",
    dedupeKey: "todo:todo-1:version-2",
    talkSessionId: "talk-1",
    topicId: "topic-1",
    source: "todo",
    subjectId: "todo-1",
    severity: "info",
    blocking: false,
    requiresOperator: false,
    summary: "A related Todo changed.",
    uiEffect: { type: "refresh", target: "todo:todo-1" },
    occurredAt: NOW,
    ...overrides,
  };
}

const context = { activeTopicId: "topic-1", knownTopicIds: ["topic-1", "topic-2"], lastSpokenAt: null, now: NOW };

describe("decideProactiveDisposition", () => {
  it("keeps relevant routine changes quiet", () => {
    expect(decideProactiveDisposition(signal(), context)).toEqual({
      disposition: "quiet", urgency: "routine", reason: "relevant-routine",
    });
  });

  it("speaks one urgent event tied to the active topic", () => {
    expect(decideProactiveDisposition(signal({ severity: "critical", blocking: true }), context)).toEqual({
      disposition: "spoken", urgency: "urgent", reason: "urgent-active-topic",
    });
  });

  it("downgrades urgent background and cooldown events to quiet cues", () => {
    const urgent = signal({ severity: "critical", blocking: true });
    expect(decideProactiveDisposition(urgent, { ...context, activeTopicId: "topic-2" })).toMatchObject({
      disposition: "quiet", reason: "urgent-background-topic",
    });
    expect(decideProactiveDisposition(urgent, { ...context, lastSpokenAt: NOW - 1_000 })).toMatchObject({
      disposition: "quiet", reason: "spoken-cooldown",
    });
  });

  it("ignores stale, unrelated, and unanchored employee noise", () => {
    expect(decideProactiveDisposition(signal({ occurredAt: NOW - 10 * 60_000 }), context)).toMatchObject({
      disposition: "ignore", reason: "stale",
    });
    expect(decideProactiveDisposition(signal({ topicId: "unknown" }), context)).toMatchObject({
      disposition: "ignore", reason: "unrelated-topic",
    });
    expect(decideProactiveDisposition(signal({ source: "employee", topicId: null }), context)).toMatchObject({
      disposition: "ignore", reason: "employee-noise",
    });
  });
});
