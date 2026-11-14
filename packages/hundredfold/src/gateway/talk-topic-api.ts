import type { IncomingMessage, ServerResponse } from "node:http";
import { initDb } from "../shared/db.js";
import type { TalkSession } from "../talk/session/types.js";
import { TalkTopicLifecycle, type ScreenTopicObservation } from "../talk/topics/lifecycle.js";
import { formatTalkTopicMemory } from "../talk/topics/rehydrate.js";
import { TalkTopicRepository } from "../talk/topics/repository.js";
import { measureTopicContext } from "../talk/topics/telemetry.js";
import { readJsonBody } from "./http-helpers.js";

interface TopicApiOptions {
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

const bounded = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.length <= limit ? value : null;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function relationObject(value: unknown): { kind: string; id: string; title?: string } | null {
  const relation = objectRecord(value);
  if (!relation) return null;
  const kind = bounded(relation.kind, 80);
  const id = bounded(relation.id, 240);
  if ([kind, id].includes(null)) return null;
  const result: { kind: string; id: string; title?: string } = { kind: kind!, id: id! };
  const title = bounded(relation.title, 240);
  if (title !== null) result.title = title;
  return result;
}

function relationObjects(value: unknown): Array<{ kind: string; id: string; title?: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).map(relationObject).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function retrievalAnchors(value: unknown): Record<string, string | number> {
  const record = objectRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).slice(0, 16).flatMap(([key, raw]) => {
    const scalar = typeof raw === "string" || typeof raw === "number";
    return key.length <= 80 && scalar ? [[key, raw as string | number]] : [];
  }));
}

function selectedObject(value: unknown): ScreenTopicObservation["selectedObject"] | undefined {
  if (value === null) return null;
  const object = objectRecord(value);
  if (!object) return undefined;
  const kind = bounded(object.kind, 80);
  const id = bounded(object.id, 240);
  const title = bounded(object.title, 240);
  if ([kind, id, title].includes(null)) return undefined;
  const result: NonNullable<ScreenTopicObservation["selectedObject"]> = {
    kind: kind!, id: id!, title: title!, relations: relationObjects(object.relations),
    retrievalAnchor: retrievalAnchors(object.retrievalAnchor),
  };
  const status = bounded(object.status, 120);
  if (status !== null) result.status = status;
  return result;
}

function screenNumbers(body: Record<string, unknown>, screen: Record<string, unknown>): { generation: number; revision: number } | null {
  const generation = body.credentialGeneration;
  const revision = screen.revision;
  if (!Number.isInteger(generation) || Number(generation) < 1) return null;
  if (!Number.isInteger(revision) || Number(revision) < 0) return null;
  return { generation: Number(generation), revision: Number(revision) };
}

export function parseScreenTopicObservation(body: Record<string, unknown>): ScreenTopicObservation | null {
  const value = objectRecord(body.screen);
  if (!value) return null;
  const routeId = bounded(value.routeId, 100);
  const path = bounded(value.path, 500);
  const title = bounded(value.title, 240);
  const freshness = value.freshness;
  const numbers = screenNumbers(body, value);
  const selected = selectedObject(value.selectedObject);
  const stringsValid = ![routeId, path, title].includes(null);
  if (!stringsValid || selected === undefined || !numbers) return null;
  if (!["complete", "partial", "stale"].includes(String(freshness))) return null;
  const meaning = bounded(value.meaningfulText, 2_000);
  return {
    credentialGeneration: numbers.generation, revision: numbers.revision, routeId: routeId!, path: path!, title: title!,
    freshness: freshness as ScreenTopicObservation["freshness"], selectedObject: selected,
    ...(meaning === null ? {} : { meaningfulText: meaning }),
  };
}

export async function handleTalkTopicContext(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  options: TopicApiOptions,
): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  if (body.browserInstanceId !== session.browserInstanceId || body.credentialGeneration !== session.credentialGeneration) {
    options.send(res, 409, { error: "The screen context does not match the active browser credential." });
    return;
  }
  const screen = parseScreenTopicObservation(body);
  if (!screen) {
    options.send(res, 400, { error: "A bounded semantic screen context is required." });
    return;
  }
  const repository = new TalkTopicRepository(initDb());
  const topic = new TalkTopicLifecycle(repository).observe(session.id, screen);
  const topics = repository.list(session.id);
  const navigation = repository.navigation(session.id);
  options.send(res, 200, {
    topic,
    topicMemory: formatTalkTopicMemory(topics, navigation.currentTopicId),
    telemetry: measureTopicContext(topics),
  });
}
