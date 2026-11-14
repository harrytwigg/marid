import type { TalkTopic, TopicResolution, TopicResolutionInput } from "./types.js";

const DAY_MS = 86_400_000;
const MATCH_THRESHOLD = 0.5;
const AMBIGUITY_MARGIN = 0.08;
const FILLER = new Set(["a", "an", "the", "thing", "one", "topic", "from", "work", "active", "open", "please"]);

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (value: string): string[] => normalize(value).split(" ").filter((token) => token && !FILLER.has(token));
const containsPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);

function byId(topics: readonly TalkTopic[], id: string | undefined): TalkTopic | undefined {
  return id ? topics.find((topic) => topic.id === id) : undefined;
}

function resolved(topic: TalkTopic | undefined, reason: string, confidence = 1): TopicResolution | null {
  return topic ? { status: "resolved", topic, reason, confidence } : null;
}

function directResolution(input: TopicResolutionInput, reference: string): TopicResolution | null {
  const currentPhrase = /^(this|current)( one| topic| screen)?$/.test(reference);
  if (currentPhrase) return resolved(byId(input.topics, input.currentTopicId), "current");
  const explicit = input.topics.find((topic) => {
    const ids = [topic.id, ...topic.objectAnchors.map((anchor) => anchor.id)];
    return ids.some((id) => containsPhrase(reference, normalize(id)));
  });
  return resolved(explicit, "explicit-anchor");
}

function historyResolution(input: TopicResolutionInput, reference: string): TopicResolution | null {
  const history = [...(input.navigationHistory ?? [])];
  if (reference.includes("go back") && reference.includes("first")) return resolved(byId(input.topics, history[0]), "history-first");
  if (reference.includes("go back")) {
    const prior = history.reverse().find((id) => id !== input.currentTopicId);
    return resolved(byId(input.topics, prior), "history-back");
  }
  return null;
}

function candidateResolution(input: TopicResolutionInput, reference: string): TopicResolution | null {
  const history = input.navigationHistory ?? [];
  const candidates = (input.lastCandidateIds ?? []).map((id) => byId(input.topics, id)).filter((topic): topic is TalkTopic => Boolean(topic));
  if (reference.includes("first one")) return resolved(candidates[0] ?? byId(input.topics, history[0]), "first-candidate");
  if (!reference.includes("other one")) return null;
  const others = candidates.filter((topic) => topic.id !== input.currentTopicId);
  if (others.length === 1) return resolved(others[0], "other-candidate");
  if (others.length > 1) return { status: "ambiguous", candidates: others.slice(0, 3), reason: "multiple-matches" };
  return null;
}

function relativeResolution(input: TopicResolutionInput, reference: string): TopicResolution | null {
  return historyResolution(input, reference) ?? candidateResolution(input, reference);
}

function dateMatches(topic: TalkTopic, reference: string, now: number): boolean {
  if (reference.includes("yesterday")) {
    const start = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    return topic.updatedAt >= start && topic.updatedAt < start + DAY_MS;
  }
  if (reference.includes("today")) return Math.floor(topic.updatedAt / DAY_MS) === Math.floor(now / DAY_MS);
  const iso = reference.match(/\b(\d{4}) (\d{2}) (\d{2})\b/);
  if (!iso) return true;
  const start = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return topic.updatedAt >= start && topic.updatedAt < start + DAY_MS;
}

function searchable(topic: TalkTopic): string {
  const anchors = topic.objectAnchors.flatMap((anchor) => [anchor.id, anchor.label ?? "", anchor.relation ?? ""]);
  return [topic.label, topic.kind, topic.verifiedState, ...anchors].join(" ");
}

function lexicalScore(reference: string, topic: TalkTopic): number {
  const query = new Set(tokens(reference).filter((token) => token !== "today" && token !== "yesterday"));
  const subject = new Set(tokens(searchable(topic)));
  if (query.size === 0) return 0;
  const overlap = [...query].filter((token) => subject.has(token)).length;
  const exact = normalize(searchable(topic)).includes([...query].join(" ")) ? 0.1 : 0;
  return Math.min(1, overlap / query.size + exact);
}

function rankedCandidates(input: TopicResolutionInput, reference: string): Array<{ topic: TalkTopic; score: number }> {
  const wantsActive = reference.includes("active work") || reference.includes("active topic");
  return input.topics
    .filter((topic) => dateMatches(topic, reference, input.now ?? Date.now()))
    .filter((topic) => !wantsActive || topic.state === "active")
    .map((topic) => ({ topic, score: lexicalScore(reference, topic) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score || right.topic.updatedAt - left.topic.updatedAt || left.topic.ordinal - right.topic.ordinal);
}

export function resolveTopicReference(input: TopicResolutionInput): TopicResolution {
  const reference = normalize(input.reference);
  const direct = directResolution(input, reference) ?? relativeResolution(input, reference);
  if (direct) return direct;
  const ranked = rankedCandidates(input, reference);
  if (ranked.length === 0) return { status: "none", reason: "below-threshold" };
  const nearBest = ranked.filter((entry) => ranked[0]!.score - entry.score <= AMBIGUITY_MARGIN).slice(0, 3);
  if (nearBest.length > 1) {
    return { status: "ambiguous", candidates: nearBest.map((entry) => entry.topic), reason: "multiple-matches" };
  }
  return { status: "resolved", topic: ranked[0]!.topic, reason: "scored-match", confidence: ranked[0]!.score };
}
