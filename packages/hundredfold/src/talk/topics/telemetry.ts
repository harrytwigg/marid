import { formatTopicContext } from "./rehydrate.js";
import type { TalkTopic, TalkTopicState } from "./types.js";

export interface TopicContextTelemetry {
  active: number;
  warm: number;
  cool: number;
  closed: number;
  rawDetailItems: number;
  estimatedTokens: number;
}

export function measureTopicContext(topics: readonly TalkTopic[]): TopicContextTelemetry {
  const counts: Record<TalkTopicState, number> = { active: 0, warm: 0, cool: 0, closed: 0 };
  let rawDetailItems = 0;
  let characters = 0;
  for (const topic of topics) {
    counts[topic.state] += 1;
    rawDetailItems += topic.rawDetails.length;
    characters += formatTopicContext(topic).length;
  }
  return {
    ...counts,
    rawDetailItems,
    estimatedTokens: Math.ceil(characters / 4),
  };
}
