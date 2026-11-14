import type { IncomingMessage, ServerResponse } from "node:http";
import type { RealtimeNoiseReduction } from "../shared/voice.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";

export interface TalkOpenRequest {
  browserInstanceId?: string;
  noiseReduction?: RealtimeNoiseReduction;
}

function noiseReduction(value: unknown, res: ServerResponse): RealtimeNoiseReduction | null | undefined {
  if (value === undefined) return undefined;
  if (value === "near_field" || value === "far_field") return value;
  json(res, { error: "noiseReduction must be near_field or far_field." }, 400);
  return null;
}

export async function readTalkOpenRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<TalkOpenRequest | null> {
  const parsed = await readJsonBody(req, res, { allowEmpty: true });
  if (!parsed.ok) return null;
  const body = (parsed.body ?? {}) as { browserInstanceId?: unknown; noiseReduction?: unknown };
  const browser = body.browserInstanceId;
  const invalidBrowser = browser !== undefined
    && (typeof browser !== "string" || browser.length < 8 || browser.length > 200);
  const profile = noiseReduction(body.noiseReduction, res);
  if (profile === null) return null;
  if (invalidBrowser) {
    json(res, { error: "A bounded browserInstanceId is required." }, 400);
    return null;
  }
  return {
    ...(typeof browser === "string" ? { browserInstanceId: browser } : {}),
    ...(profile ? { noiseReduction: profile } : {}),
  };
}

export async function readTalkAudioProfile(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RealtimeNoiseReduction | null | undefined> {
  const parsed = await readJsonBody(req, res, { allowEmpty: true });
  if (!parsed.ok) return null;
  return noiseReduction((parsed.body as { noiseReduction?: unknown } | undefined)?.noiseReduction, res);
}
