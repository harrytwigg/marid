import type { TalkTopic, TopicCollectionResult } from "./types.js";

export interface TopicGarbageCollectionOptions {
  now: number;
  currentTopicId?: string;
  maxWarmTopics: number;
  rawDetailItemBudget: number;
  closedRetentionMs: number;
}

function hasCommitment(topic: TalkTopic): boolean {
  return Boolean(topic.goal || topic.decisions.length || topic.unresolvedQuestions.length || topic.retrievalAnchors.length);
}

function shouldExpire(topic: TalkTopic, options: TopicGarbageCollectionOptions): boolean {
  if (topic.id === options.currentTopicId || topic.state !== "closed" || !topic.transient || hasCommitment(topic)) return false;
  return topic.closedAt !== null && topic.closedAt < options.now - options.closedRetentionMs;
}

function warmTopics(topics: readonly TalkTopic[], options: TopicGarbageCollectionOptions): TalkTopic[] {
  const protectedIds = new Set(topics.filter((topic) =>
    topic.id === options.currentTopicId || topic.state === "active" || topic.unresolvedQuestions.length > 0,
  ).map((topic) => topic.id));
  const available = Math.max(0, options.maxWarmTopics - protectedIds.size);
  const newest = topics.filter((topic) => topic.state === "warm" && !protectedIds.has(topic.id))
    .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, available);
  const retained = new Set([...protectedIds, ...newest.map((topic) => topic.id)]);
  return topics.map((topic) => {
    if (topic.state === "closed") return topic;
    if (retained.has(topic.id)) return { ...topic, state: topic.state === "active" ? "active" : "warm" };
    return { ...topic, state: "cool" };
  });
}

function compactRawDetails(topics: readonly TalkTopic[], options: TopicGarbageCollectionOptions): {
  topics: TalkTopic[]; compactedIds: string[];
} {
  let remaining = Math.max(0, options.rawDetailItemBudget);
  const priority = [...topics].sort((left, right) => {
    const leftProtected = Number(left.id === options.currentTopicId || left.state === "active" || left.unresolvedQuestions.length > 0);
    const rightProtected = Number(right.id === options.currentTopicId || right.state === "active" || right.unresolvedQuestions.length > 0);
    return rightProtected - leftProtected || right.updatedAt - left.updatedAt;
  });
  const details = new Map<string, string[]>();
  const compactedIds: string[] = [];
  for (const topic of priority) {
    const kept = topic.rawDetails.slice(0, remaining);
    remaining -= kept.length;
    details.set(topic.id, kept);
    if (kept.length < topic.rawDetails.length) compactedIds.push(topic.id);
  }
  return { topics: topics.map((topic) => ({ ...topic, rawDetails: details.get(topic.id) ?? [] })), compactedIds };
}

export function collectTopicGarbage(
  input: readonly TalkTopic[], options: TopicGarbageCollectionOptions,
): TopicCollectionResult {
  const expiredIds = input.filter((topic) => shouldExpire(topic, options)).map((topic) => topic.id);
  const expired = new Set(expiredIds);
  const retained = warmTopics(input.filter((topic) => !expired.has(topic.id)), options);
  const compacted = compactRawDetails(retained, options);
  const rawDetailItems = compacted.topics.reduce((sum, topic) => sum + topic.rawDetails.length, 0);
  return {
    topics: compacted.topics,
    compactedIds: compacted.compactedIds,
    expiredIds,
    stats: { compactedTopics: compacted.compactedIds.length, expiredTopics: expiredIds.length, rawDetailItems },
  };
}
