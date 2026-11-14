/**
 * Per-message read-aloud TTS. Lifted out of api.ts when the talk router was
 * added: these are talk-domain routes, and they are unrelated to the realtime
 * session runtime next door.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HundredfoldConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { streamTtsSentences, ttsStatus, validateTtsText } from "../talk/tts-stream.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";

type TtsRequest = Parameters<typeof readJsonBody>[0];

type KokoroOptions = NonNullable<HundredfoldConfig["talk"]>["kokoro"];

/**
 * Stream one length-prefixed WAV frame per sentence as each is synthesized, so
 * the client plays sentence 1 while 2..N are still being synthesized
 * (time-to-first-audio is one sentence, not the whole message). Frame = 4-byte
 * big-endian length + WAV bytes.
 */
async function streamFrames(
  req: IncomingMessage,
  res: ServerResponse,
  text: string,
  kokoroOpts: KokoroOptions,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
  });
  // A client abort (pause / navigate) closes the request → stop synthesizing the
  // rest of the message instead of wasting Kokoro on audio nobody hears.
  let cancelled = false;
  req.on("close", () => {
    cancelled = true;
  });
  try {
    await streamTtsSentences(
      text,
      kokoroOpts,
      (wav) => {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(wav.length, 0);
        res.write(header);
        res.write(wav);
      },
      () => cancelled || res.writableEnded,
    );
  } catch (err) {
    logger.warn(`TTS stream failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.writableEnded) res.end();
}

/**
 * Handle `/api/tts`, returning false for anything else so the caller falls
 * through to the rest of the talk router.
 *
 * GET reports engine readiness so the client can pick Kokoro over the browser's
 * Web Speech fallback WITHOUT a failed POST. POST 503s `{available:false}` when
 * Kokoro cannot run, at which point the client falls back to Web Speech.
 */
export async function handleTalkTtsApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: HundredfoldConfig,
): Promise<boolean> {
  if (pathname !== "/api/tts") return false;
  const method = req.method ?? "GET";
  const kokoroOpts = config.talk?.kokoro;

  if (method === "GET") {
    const { available, voice } = ttsStatus(kokoroOpts);
    json(res, { available, voice });
    return true;
  }
  if (method !== "POST") return false;
  if (!ttsStatus(kokoroOpts).available) {
    json(res, { available: false }, 503);
    return true;
  }
  const parsed = await readJsonBody(req as TtsRequest, res);
  if (!parsed.ok) return true;
  const valid = validateTtsText((parsed.body as { text?: unknown } | null)?.text);
  if (!valid.ok) {
    json(res, { error: valid.error }, 400);
    return true;
  }
  await streamFrames(req, res, valid.text, kokoroOpts);
  return true;
}
