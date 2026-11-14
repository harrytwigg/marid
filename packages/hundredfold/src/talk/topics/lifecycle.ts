import { createHash } from "node:crypto";
import { collectTopicGarbage } from "./garbage-collector.js";
import { TalkTopicRepository } from "./repository.js";
import { resolveTopicReference } from "./resolver.js";
import type { TalkTopic, TalkTopicKind, TalkTopicNavigation, TalkTopicObjectAnchor, TopicResolution } from "./types.js";

const MAX_HISTORY = 40;
const MAX_COMMITMENTS = 24;

export interface ScreenTopicObservation {
  credentialGeneration: number;
  revision: number;
  routeId: string;
  path: string;
  title: string;
  freshness: "complete" | "partial" | "stale";
  meaningfulText?: string;
  selectedObject?: {
    kind: string;
    id: string;
    title: string;
    status?: string;
    relations?: Array<{ kind: string; id: string; title?: string }>;
    retrievalAnchor?: Record<string, string | number>;
  } | null;
}

export interface TopicCommitmentInput {
  topicId?: string;
  goal?: string;
  decision?: string;
  unresolvedQuestion?: string;
  resolvedQuestion?: string;
}

const clip = (value: string, limit = 500): string => value.replace(/\s+/g, " ").trim().slice(0, limit);

function topicKind(value: string): TalkTopicKind {
  const kind = value.toLowerCase();
  if (kind.includes("todo")) return "todo";
  if (kind.includes("workflow")) return "workflow";
  if (kind.includes("chat") || kind.includes("session")) return "chat";
  return "other";
}

function anchorFor(screen: ScreenTopicObservation): TalkTopicObjectAnchor {
  const selected = screen.selectedObject;
  return selected
    ? { kind: selected.kind, id: selected.id, label: clip(selected.title, 120) }
    : { kind: "route", id: screen.path, label: clip(screen.title, 120) };
}

function topicId(talkSessionId: string, anchor: TalkTopicObjectAnchor): string {
  const digest = createHash("sha256").update(`${talkSessionId}\0${anchor.kind}\0${anchor.id}`).digest("hex").slice(0, 20);
  return `topic-${digest}`;
}

function retrieval(screen: ScreenTopicObservation): string[] {
  const entries = Object.entries(screen.selectedObject?.retrievalAnchor ?? {})
    .map(([key, value]) => `${key}:${String(value).slice(0, 160)}`);
  return [...new Set([`route:${screen.path.slice(0, 240)}`, ...entries])];
}

function details(screen: ScreenTopicObservation): string[] {
  const lines = [screen.meaningfulText, ...(screen.selectedObject?.relations ?? []).map((relation) =>
    `${relation.kind}:${relation.id}${relation.title ? ` ${relation.title}` : ""}`)];
  return lines.filter((value): value is string => Boolean(value)).map((value) => clip(value)).slice(0, 12);
}

function verifiedState(screen: ScreenTopicObservation): string {
  const selected = screen.selectedObject;
  return clip([screen.freshness, selected?.status, screen.meaningfulText].filter(Boolean).join(" · "));
}

function appendUnique(values: readonly string[], value: string | undefined): string[] {
  const next = value ? clip(value) : "";
  return next ? [...new Set([...values, next])].slice(-MAX_COMMITMENTS) : [...values];
}

function staleObservation(screen: ScreenTopicObservation, navigation: TalkTopicNavigation): boolean {
  if (screen.credentialGeneration < navigation.credentialGeneration) return true;
  return screen.credentialGeneration === navigation.credentialGeneration && screen.revision <= navigation.screenRevision;
}

function warmPrevious(repository: TalkTopicRepository, topics: readonly TalkTopic[], currentId: string, at: number): void {
  const active = topics.filter((topic) => topic.state === "active").filter((topic) => topic.id !== currentId);
  for (const topic of active) repository.put({ ...topic, state: "warm", updatedAt: at, revision: topic.revision + 1 });
}

interface ObservedTopicInput {
  id: string;
  talkSessionId: string;
  ordinal: number;
  screen: ScreenTopicObservation;
  anchor: TalkTopicObjectAnchor;
  existing: TalkTopic | null;
  at: number;
}

function observedTopic(input: ObservedTopicInput): TalkTopic {
  const label = clip(input.screen.selectedObject?.title ?? input.screen.title, 120);
  if (input.existing) return {
    ...input.existing, state: "active", label, objectAnchors: [input.anchor],
    verifiedState: verifiedState(input.screen), retrievalAnchors: retrieval(input.screen), rawDetails: details(input.screen),
    updatedAt: input.at, revision: input.existing.revision + 1,
  };
  return {
    id: input.id, talkSessionId: input.talkSessionId, ordinal: input.ordinal,
    kind: topicKind(input.screen.selectedObject?.kind ?? input.screen.routeId), state: "active", label,
    objectAnchors: [input.anchor], goal: "", verifiedState: verifiedState(input.screen), decisions: [],
    unresolvedQuestions: [], retrievalAnchors: retrieval(input.screen), rawDetails: details(input.screen),
    transient: !input.screen.selectedObject, createdAt: input.at, updatedAt: input.at, closedAt: null, revision: 1,
  };
}

export class TalkTopicLifecycle {
  constructor(private readonly repository: TalkTopicRepository, private readonly now: () => number = Date.now) {}

  observe(talkSessionId: string, screen: ScreenTopicObservation): TalkTopic {
    const at = this.now();
    const priorNavigation = this.repository.navigation(talkSessionId);
    if (staleObservation(screen, priorNavigation)) {
      const current = priorNavigation.currentTopicId ? this.repository.get(priorNavigation.currentTopicId) : null;
      if (current) return current;
    }
    const anchor = anchorFor(screen);
    const id = topicId(talkSessionId, anchor);
    const topics = this.repository.list(talkSessionId);
    warmPrevious(this.repository, topics, id, at);
    const next = observedTopic({ id, talkSessionId, ordinal: topics.length + 1, screen, anchor,
      existing: this.repository.get(id), at });
    const saved = this.repository.put(next);
    const navigation = this.repository.navigation(talkSessionId);
    const history = [...navigation.history.filter((topic) => topic !== id), id].slice(-MAX_HISTORY);
    this.repository.saveNavigation({ talkSessionId, currentTopicId: id, history, lastCandidateIds: [],
      credentialGeneration: screen.credentialGeneration, screenRevision: screen.revision, updatedAt: at });
    this.collect(talkSessionId);
    return saved;
  }

  resolve(talkSessionId: string, reference: string): TopicResolution {
    const navigation = this.repository.navigation(talkSessionId);
    const result = resolveTopicReference({ reference, topics: this.repository.list(talkSessionId),
      currentTopicId: navigation.currentTopicId ?? undefined, navigationHistory: navigation.history,
      lastCandidateIds: navigation.lastCandidateIds, now: this.now() });
    if (result.status === "ambiguous") {
      this.repository.saveNavigation({ ...navigation, lastCandidateIds: result.candidates.map((topic) => topic.id), updatedAt: this.now() });
    } else if (result.status === "resolved") {
      this.activate(talkSessionId, result.topic.id);
    }
    return result;
  }

  remember(talkSessionId: string, input: TopicCommitmentInput): TalkTopic {
    const current = this.repository.navigation(talkSessionId).currentTopicId;
    const topic = this.repository.get(input.topicId ?? current ?? "");
    if (!topic || topic.talkSessionId !== talkSessionId) throw new Error("The referenced Talk topic does not exist.");
    const questions = appendUnique(topic.unresolvedQuestions, input.unresolvedQuestion)
      .filter((question) => !input.resolvedQuestion || question !== clip(input.resolvedQuestion));
    const next = {
      ...topic,
      goal: input.goal ? clip(input.goal) : topic.goal,
      decisions: appendUnique(topic.decisions, input.decision),
      unresolvedQuestions: questions,
      updatedAt: this.now(),
      revision: topic.revision + 1,
    };
    return this.repository.put(next);
  }

  private activate(talkSessionId: string, topicIdValue: string): void {
    const at = this.now();
    for (const topic of this.repository.list(talkSessionId)) {
      const state = topic.id === topicIdValue ? "active" : topic.state === "active" ? "warm" : topic.state;
      if (state !== topic.state) this.repository.put({ ...topic, state, updatedAt: at, revision: topic.revision + 1 });
    }
    const navigation = this.repository.navigation(talkSessionId);
    const history = [...navigation.history.filter((id) => id !== topicIdValue), topicIdValue].slice(-MAX_HISTORY);
    this.repository.saveNavigation({ ...navigation, talkSessionId, currentTopicId: topicIdValue,
      history, lastCandidateIds: [], updatedAt: at });
  }

  private collect(talkSessionId: string): void {
    const navigation = this.repository.navigation(talkSessionId);
    const collected = collectTopicGarbage(this.repository.list(talkSessionId), {
      now: this.now(), currentTopicId: navigation.currentTopicId ?? undefined, maxWarmTopics: 24,
      rawDetailItemBudget: 48, closedRetentionMs: 30 * 86_400_000,
    });
    if (collected.compactedIds.length || collected.expiredIds.length
      || collected.topics.some((topic) => this.repository.get(topic.id)?.state !== topic.state)) {
      this.repository.replaceSession(talkSessionId, collected.topics);
    }
  }
}
