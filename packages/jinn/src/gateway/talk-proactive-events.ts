import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { GatewayEmit, GatewayEvent } from "../shared/gateway-events.js";
import { TalkProactiveRepository } from "../talk/proactive/repository.js";
import { TalkProactiveService } from "../talk/proactive/service.js";
import type { ProactiveSignal } from "../talk/proactive/types.js";
import { TalkSessionRepository } from "../talk/session/repository.js";
import { TalkTopicRepository } from "../talk/topics/repository.js";
import type { TalkTopic } from "../talk/topics/types.js";

interface GatewaySignalSource {
  source: ProactiveSignal["source"];
  subjectIds: string[];
  severity: ProactiveSignal["severity"];
  blocking: boolean;
  requiresOperator: boolean;
  summary: string;
  target: string;
  dedupeSeed: string;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 32);
const bucket = (now: number): number => Math.floor(now / 30_000);

function todoSource(frame: Extract<GatewayEvent, { event: "company:changed" }>): GatewaySignalSource | null {
  const payload = frame.payload;
  if (payload.entity !== "todo") return null;
  const status = typeof payload.value?.status === "string" ? payload.value.status : "";
  const blocked = status === "blocked";
  return {
    source: "todo", subjectIds: [payload.id], severity: blocked ? "warning" : "info",
    blocking: blocked, requiresOperator: false,
    summary: blocked ? "A related Todo became blocked." : "A related Todo changed.",
    target: `todo:${payload.id}`, dedupeSeed: `todo:${payload.id}:${payload.version}`,
  };
}

function companySource(frame: Extract<GatewayEvent, { event: "company:changed" }>): GatewaySignalSource | null {
  const todo = todoSource(frame);
  if (todo) return todo;
  return null;
}

function sourceFor(frame: GatewayEvent, now: number): GatewaySignalSource | null {
  if (frame.event === "company:changed") return companySource(frame);
  if (frame.event === "session:completed") {
    const failed = frame.payload.error !== null;
    return {
      source: "chat", subjectIds: [frame.payload.sessionId], severity: failed ? "critical" : "success",
      blocking: failed, requiresOperator: false, summary: failed ? "A related chat failed." : "A related chat completed.",
      target: `chat:${frame.payload.sessionId}`,
      dedupeSeed: `chat:${frame.payload.sessionId}:${digest(JSON.stringify(frame.payload))}`,
    };
  }
  if (frame.event === "cron:run-finished") {
    const failed = frame.payload.status === "error";
    return {
      source: "cron", subjectIds: [frame.payload.jobId], severity: failed ? "critical" : "success",
      blocking: failed, requiresOperator: false,
      summary: failed ? "A related scheduled job failed." : "A related scheduled job completed.",
      target: `cron:${frame.payload.jobId}`, dedupeSeed: `cron:${frame.payload.jobId}:${frame.payload.status}:${bucket(now)}`,
    };
  }
  return null;
}

function matches(topic: TalkTopic, source: GatewaySignalSource): boolean {
  return topic.objectAnchors.some((anchor) => source.subjectIds.includes(anchor.id));
}

function selectTopic(topics: readonly TalkTopic[], currentId: string | null, source: GatewaySignalSource): TalkTopic | null {
  return topics.filter((topic) => matches(topic, source)).sort((left, right) => {
    const current = Number(right.id === currentId) - Number(left.id === currentId);
    const active = Number(right.state === "active") - Number(left.state === "active");
    return current || active || right.updatedAt - left.updatedAt;
  })[0] ?? null;
}

export function createTalkProactiveGatewayEmit(
  database: Database,
  broadcast: GatewayEmit,
  now: () => number = Date.now,
): GatewayEmit {
  const sessions = new TalkSessionRepository(database);
  const topics = new TalkTopicRepository(database);
  const service = new TalkProactiveService(new TalkProactiveRepository(database), now);
  const bridge = (frame: GatewayEvent): void => {
    const at = now();
    const source = sourceFor(frame, at);
    if (!source) return;
    for (const session of sessions.list().filter((entry) => entry.state === "live")) {
      const known = topics.list(session.id);
      const navigation = topics.navigation(session.id);
      const topic = selectTopic(known, navigation.currentTopicId, source);
      if (!topic) continue;
      const activeTopicId = navigation.currentTopicId ?? known.find((entry) => entry.state === "active")?.id ?? null;
      const dedupeKey = source.dedupeSeed;
      const signal: ProactiveSignal = {
        eventId: digest(`${frame.event}:${dedupeKey}`), dedupeKey, talkSessionId: session.id, topicId: topic.id,
        source: source.source, subjectId: source.subjectIds[0]!, severity: source.severity,
        blocking: source.blocking, requiresOperator: source.requiresOperator, summary: source.summary,
        uiEffect: { type: "refresh", target: source.target }, occurredAt: at,
      };
      service.handle(signal, { activeTopicId, knownTopicIds: known.map((entry) => entry.id) },
        (cue) => broadcast("talk:proactive-cue", cue));
    }
  };
  return ((event, payload) => {
    broadcast(event, payload);
    if (event !== "talk:proactive-cue") bridge({ event, payload } as GatewayEvent);
  }) as GatewayEmit;
}
