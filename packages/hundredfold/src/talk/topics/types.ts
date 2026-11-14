export type TalkTopicKind = "chat" | "todo" | "workflow" | "other";
export type TalkTopicState = "active" | "warm" | "cool" | "closed";

export interface TalkTopicObjectAnchor {
  kind: string;
  id: string;
  label?: string;
  relation?: string;
}

/** Durable semantic memory for one strand of a Talk conversation. */
export interface TalkTopic {
  id: string;
  talkSessionId: string;
  ordinal: number;
  kind: TalkTopicKind;
  state: TalkTopicState;
  label: string;
  objectAnchors: TalkTopicObjectAnchor[];
  goal: string;
  verifiedState: string;
  decisions: string[];
  unresolvedQuestions: string[];
  retrievalAnchors: string[];
  /** Bulky evidence is expendable; every field above is a commitment. */
  rawDetails: string[];
  transient: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  revision: number;
}

export interface TalkTopicNavigation {
  talkSessionId: string;
  currentTopicId: string | null;
  history: string[];
  lastCandidateIds: string[];
  credentialGeneration: number;
  screenRevision: number;
  updatedAt: number;
}

export interface TopicResolutionInput {
  reference: string;
  topics: readonly TalkTopic[];
  currentTopicId?: string;
  navigationHistory?: readonly string[];
  lastCandidateIds?: readonly string[];
  now?: number;
}

export type TopicResolution =
  | { status: "resolved"; topic: TalkTopic; reason: string; confidence: number }
  | { status: "ambiguous"; candidates: TalkTopic[]; reason: "multiple-matches" }
  | { status: "none"; reason: "below-threshold" };

export interface TopicCollectionStats {
  compactedTopics: number;
  expiredTopics: number;
  rawDetailItems: number;
}

export interface TopicCollectionResult {
  topics: TalkTopic[];
  compactedIds: string[];
  expiredIds: string[];
  stats: TopicCollectionStats;
}
