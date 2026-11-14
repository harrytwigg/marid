import type { IncomingMessage, ServerResponse } from "node:http";
import type { TalkSessionRegistry } from "../talk/session/registry.js";
import type { TalkInterruptionRecord, TalkSession } from "../talk/session/types.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";

const FIELDS = new Set(["kind", "vadType", "cancelledBy", "recovered", "speechMs"]);
const VAD_TYPES = new Set<unknown>(["server_vad", "semantic_vad"]);
const MAX_SPEECH_MS = 600_000;

type InterruptionInput = Omit<TalkInterruptionRecord, "at">;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === FIELDS.size && keys.every((key) => FIELDS.has(key));
}

function validSpeechMs(value: unknown): value is number | null {
  if (value === null) return true;
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SPEECH_MS;
}

function interruption(value: unknown): InterruptionInput | null {
  const raw = record(value);
  if (!raw || !exactFields(raw)) return null;
  if (raw.kind !== "speech_interruption") return null;
  if (!VAD_TYPES.has(raw.vadType)) return null;
  if (raw.cancelledBy !== "provider") return null;
  if (typeof raw.recovered !== "boolean") return null;
  if (!validSpeechMs(raw.speechMs)) return null;
  return {
    kind: raw.kind,
    vadType: raw.vadType as InterruptionInput["vadType"],
    cancelledBy: raw.cancelledBy,
    recovered: raw.recovered,
    speechMs: raw.speechMs,
  };
}

/** Accept only bounded detection metadata. Unknown fields are rejected rather
 * than ignored so transcript or audio can never hitchhike into telemetry. */
export async function recordInterruption(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  registry: TalkSessionRegistry,
): Promise<void> {
  const parsed = await readJsonBody(req, res, { maxBytes: 2_048, rejectDuplicateTopLevelKeys: true });
  if (!parsed.ok) return;
  const input = interruption(parsed.body);
  if (!input) {
    json(res, { error: "Interruption telemetry must contain exactly the bounded content-free metadata fields." }, 400);
    return;
  }
  json(res, registry.recordInterruption(session.id, input), 201);
}
