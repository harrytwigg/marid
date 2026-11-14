import type { TalkTopic, TalkTopicObjectAnchor } from "./types.js";

export interface TopicLiveState {
  verifiedState: string;
  rawDetails?: string[];
  objectAnchors?: TalkTopicObjectAnchor[];
  retrievalAnchors?: string[];
}

export type TopicStateLoader = (retrievalAnchors: readonly string[]) => Promise<TopicLiveState>;

/** Refresh expendable source state while retaining every conversational commitment. */
export async function rehydrateTopic(topic: TalkTopic, load: TopicStateLoader, now = Date.now()): Promise<TalkTopic> {
  const live = await load(topic.retrievalAnchors);
  return {
    ...topic,
    state: topic.state === "active" ? "active" : "warm",
    verifiedState: live.verifiedState,
    rawDetails: live.rawDetails ?? topic.rawDetails,
    objectAnchors: live.objectAnchors ?? topic.objectAnchors,
    retrievalAnchors: live.retrievalAnchors ?? topic.retrievalAnchors,
    updatedAt: now,
    revision: topic.revision + 1,
  };
}

/** Stable, compact provider context; raw detail is deliberately last. */
export function formatTopicContext(topic: TalkTopic): string {
  return JSON.stringify({
    id: topic.id,
    label: topic.label,
    kind: topic.kind,
    state: topic.state,
    goal: topic.goal,
    verifiedState: topic.verifiedState,
    decisions: topic.decisions,
    unresolvedQuestions: topic.unresolvedQuestions,
    objectAnchors: topic.objectAnchors,
    retrievalAnchors: topic.retrievalAnchors,
    rawDetails: topic.rawDetails,
  });
}

/** Bounded provider memory: current topic in full, earlier strands as durable commitments. */
export function formatTalkTopicMemory(topics: readonly TalkTopic[], currentTopicId: string | null, budget = 6_000): string {
  const current = topics.find((topic) => topic.id === currentTopicId);
  const earlier = topics.filter((topic) => topic.id !== currentTopicId).map((topic) => ({
    id: topic.id,
    label: topic.label,
    kind: topic.kind,
    state: topic.state,
    goal: topic.goal,
    decisions: topic.decisions,
    unresolvedQuestions: topic.unresolvedQuestions,
    objectAnchors: topic.objectAnchors,
    retrievalAnchors: topic.retrievalAnchors,
  }));
  return JSON.stringify({ current: current ? JSON.parse(formatTopicContext(current)) : null, earlier }).slice(0, budget);
}
