/**
 * The `/api/talk/sessions/:id/*` operations that carry a request body: recording
 * a turn's usage, logging an attempted write, and handing a request off to a
 * normal text session.
 *
 * Split out of talk-api.ts, which keeps the routing, the credential minting, and
 * the lifecycle transitions. The registry is passed in rather than imported so
 * the two modules do not have to reference each other.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JinnConfig, Session } from "../shared/types.js";
import type { RealtimeUsage } from "../shared/voice.js";
import { createSession, getSession, insertMessage } from "../sessions/registry.js";
import { childFallbackMode } from "../sessions/session-fallback.js";
import { priceTurn } from "../talk/session/pricing.js";
import type { TalkSessionRegistry } from "../talk/session/registry.js";
import type { TalkActionRecord, TalkSession, VisualCaptureReceipt } from "../talk/session/types.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";
import { persistTalkTurn } from "./talk-turn-recording.js";

type JsonRequest = Parameters<typeof readJsonBody>[0];

// Only the argument order is local: the status varies per call site, so one shim
// covers all ten — six of which land on badRequest's shape.
const send = (res: ServerResponse, status: number, body: unknown): void => json(res, body, status);

/** Accept a usage payload only when every token count is a non-negative finite
 *  number, so a malformed client cannot quietly bill a session zero. */
function tokenCount(raw: Record<string, unknown>, key: string, optional = false): number | null {
  const count = raw[key]
  if (count === undefined && optional) return 0
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null
}

function numericUsage(value: unknown): RealtimeUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "inputAudioTokens",
    "outputAudioTokens",
    "inputTextTokens",
    "outputTextTokens",
    "cachedInputAudioTokens",
    "cachedInputTextTokens",
  ] as const;
  const usage = {} as RealtimeUsage;
  for (const key of keys) {
    const count = tokenCount(raw, key)
    if (count === null) return null
    usage[key] = count;
  }
  for (const key of ["inputImageTokens", "cachedInputImageTokens"] as const) {
    const count = tokenCount(raw, key, true)
    if (count === null) return null
    usage[key] = count
  }
  return usage;
}

const VISUAL_RECEIPT_FIELDS = [
  "contextRevision",
  "bytes",
  "width",
  "height",
  "estimatedImageTokens",
  "latencyMs",
] as const;

function boundedLabel(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function visualReceipt(value: unknown): VisualCaptureReceipt | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const hasNumbers = VISUAL_RECEIPT_FIELDS.every((key) => tokenCount(raw, key) !== null)
  if (!boundedLabel(raw.requestKey, 200) || !boundedLabel(raw.reason, 120) || !hasNumbers) return null
  if ((raw.bytes as number) > 180_000 || (raw.width as number) > 1280 || (raw.height as number) > 1280) return null
  return raw as unknown as VisualCaptureReceipt
}

function visualReceipts(value: unknown): VisualCaptureReceipt[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) return null
  const receipts = value.map(visualReceipt)
  return receipts.includes(null) ? null : receipts as VisualCaptureReceipt[]
}

function providerIdentityProblem(body: { providerResponseId?: unknown; providerItemId?: unknown }): string | null {
  if (body.providerResponseId !== undefined && !boundedLabel(body.providerResponseId, 200)) return "providerResponseId";
  if (body.providerItemId !== undefined && !boundedLabel(body.providerItemId, 200)) return "providerItemId";
  return null;
}

function providerIdentities(body: { providerResponseId?: unknown; providerItemId?: unknown }): {
  providerResponseId?: string; providerItemId?: string;
} {
  const result: { providerResponseId?: string; providerItemId?: string } = {};
  if (typeof body.providerResponseId === "string") result.providerResponseId = body.providerResponseId;
  if (typeof body.providerItemId === "string") result.providerItemId = body.providerItemId;
  return result;
}

/**
 * `usage` is this turn's delta, not a session-to-date total: the provider's
 * `turn_done` event reports the running total, so the client subtracts before
 * posting. Spend goes through `recordTurnAccounting`, the single accounting
 * entry point, which is what puts a talk session in the cost report for free.
 */
export async function recordTurn(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  registry: TalkSessionRegistry,
): Promise<void> {
  const parsed = await readJsonBody(req as JsonRequest, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as { usage?: unknown; transcript?: unknown; visualReceipts?: unknown; providerResponseId?: unknown; providerItemId?: unknown };
  const usage = numericUsage(body.usage);
  const receipts = visualReceipts(body.visualReceipts);
  if (!usage) {
    send(res, 400, { error: "usage must carry a non-negative number for every RealtimeUsage token count." });
    return;
  }
  if (body.transcript !== undefined && typeof body.transcript !== "string") {
    send(res, 400, { error: "transcript must be a string when present." });
    return;
  }
  if (!receipts) {
    send(res, 400, { error: "visualReceipts must contain only bounded public capture metadata." });
    return;
  }
  const identityProblem = providerIdentityProblem(body);
  if (identityProblem) {
    send(res, 400, { error: `${identityProblem} must be a bounded string when present.` });
    return;
  }
  const priced = priceTurn(session.model, usage);
  const turn = persistTalkTurn({
    session,
    registry,
    usage,
    transcript: body.transcript ?? "",
    visualReceipts: receipts,
    ...providerIdentities(body),
    costUsd: priced.costUsd,
  });
  send(res, 200, {
    ...turn,
    costUsd: priced.costUsd,
    pricingKnown: priced.pricingKnown,
  });
}

const ACTION_LANES = ["fast", "consent"] as const;
const ACTION_CONSENTS = ["not-required", "granted", "refused"] as const;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** The first thing wrong with an action payload, phrased as the fix, or null
 *  when there is nothing wrong with it. */
function actionProblem(body: Record<string, unknown>, logged: readonly TalkActionRecord[]): string | null {
  if (typeof body.tool !== "string" || !body.tool.trim()) {
    return "tool must be the non-empty name of the tool that attempted the write.";
  }
  if (body.subject !== undefined && body.subject !== null && typeof body.subject !== "string") {
    return "subject must be an id string, or null when the tool acts on no single thing.";
  }
  if (!isOneOf(body.lane, ACTION_LANES)) return `lane must be one of: ${ACTION_LANES.join(", ")}.`;
  if (!isOneOf(body.consent, ACTION_CONSENTS)) return `consent must be one of: ${ACTION_CONSENTS.join(", ")}.`;
  if (body.undoOf !== undefined && !logged.some((action) => action.id === body.undoOf)) {
    return "undoOf must name an action this talk session already logged.";
  }
  return null;
}

/**
 * One log entry per attempted write, refusals included: a write the operator
 * waved off is the decision the audit most needs to show, and it reaches the
 * gateway no other way because it performs no write.
 *
 * `id` and `at` are stamped by the registry rather than read from the body, for
 * the same reason comment authorship is: a caller that can name and date its own
 * entry can forge one over an earlier one.
 */
export async function recordAction(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  registry: TalkSessionRegistry,
): Promise<void> {
  const parsed = await readJsonBody(req as JsonRequest, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const problem = actionProblem(body, session.actions);
  if (problem) {
    send(res, 400, { error: problem });
    return;
  }
  send(res, 201, registry.recordAction(session.id, {
    tool: body.tool as string,
    subject: (body.subject as string | null | undefined) ?? null,
    lane: body.lane as TalkActionRecord["lane"],
    consent: body.consent as TalkActionRecord["consent"],
    undoOf: body.undoOf as string | undefined,
  }));
}

/** Spawn a normal text session with the talk session's row as its parent, so the
 *  existing callback machinery reaches it without anyone polling. */
export async function handOff(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  config: JinnConfig,
  runHandoff?: (spawned: Session, prompt: string) => void,
): Promise<void> {
  const parsed = await readJsonBody(req as JsonRequest, res);
  if (!parsed.ok) return;
  const prompt = (parsed.body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    send(res, 400, { error: "prompt must be a non-empty string." });
    return;
  }
  const spawned = createSession({
    engine: config.engines.default,
    source: "web",
    sourceRef: `talk-handoff:${randomUUID()}`,
    connector: "web",
    replyContext: { source: "web" },
    parentSessionId: session.sessionId,
    fallbackMode: childFallbackMode(config, getSession(session.sessionId)),
    prompt,
  });
  insertMessage(spawned.id, "user", prompt);
  runHandoff?.(spawned, prompt);
  send(res, 201, { sessionId: spawned.id, parentSessionId: session.sessionId });
}
