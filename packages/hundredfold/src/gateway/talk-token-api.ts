import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { HundredfoldConfig } from "../shared/types.js";
import type {
  RealtimeNoiseReduction,
  RealtimeTool,
  RealtimeTurnDetection,
} from "../shared/voice.js";
import { logger } from "../shared/logger.js";
import { UnknownRealtimeProviderError, createRealtimeProvider } from "../talk/realtime/index.js";
import { json } from "./route-helpers.js";

/**
 * Mint a provider credential, optionally requiring it to outlive a predecessor.
 *
 * Configuration gaps and provider failures are translated into the Talk HTTP
 * contract here so callers only need to decide which tool catalog to expose.
 */
export async function mintTalkToken(res: ServerResponse, config: HundredfoldConfig, tools: RealtimeTool[],
  expiresAfter?: number, noiseReduction?: RealtimeNoiseReduction) {
  const turnDetection = automaticTurnDetection(config.realtime?.turnDetection);
  const effectiveNoiseReduction = noiseReduction ?? config.realtime?.noiseReduction ?? "far_field";
  const mint = async () => {
    let realtime;
    try {
      realtime = createRealtimeProvider(config.realtime ?? {});
    } catch (error) {
      const detail = error instanceof UnknownRealtimeProviderError || error instanceof Error
        ? error.message
        : "realtime is not configured";
      json(res, {
        error: "Voice is not available.",
        reason: "unconfigured",
        detail,
      }, 503);
      return null;
    }
    try {
      const token = await realtime.mintEphemeralToken({ tools, turnDetection, noiseReduction: effectiveNoiseReduction });
      return {
        ...token,
        vadType: turnDetection.type,
        noiseReduction: effectiveNoiseReduction,
      };
    } catch (error) {
      logger.warn(`Realtime token mint failed: ${error instanceof Error ? error.message : String(error)}`);
      json(res, { error: "The realtime provider refused to issue a session credential." }, 502);
      return null;
    }
  };

  const token = await mint();
  if (expiresAfter === undefined || !token || token.expiresAt > expiresAfter) return token;

  // Provider expiries are whole seconds. Waiting out the current second gives
  // a resumed session one chance to receive a genuinely longer-lived token.
  await delay(1000 - (Date.now() % 1000));
  const retried = await mint();
  if (!retried || retried.expiresAt > expiresAfter) return retried;
  json(res, {
    error: "The realtime provider reissued a session credential that expires no later than the one it replaced.",
  }, 502);
  return null;
}

/** Browser Talk always needs provider-owned VAD. `none` remains valid for
 * direct push-to-talk provider consumers, but cannot drive the Talk orb. */
function automaticTurnDetection(
  configured: RealtimeTurnDetection | undefined,
): Exclude<RealtimeTurnDetection, "none" | "server_vad"> | { type: "server_vad" } {
  if (!configured || configured === "none") return { type: "semantic_vad", eagerness: "medium" };
  if (configured === "server_vad") return { type: "server_vad" };
  return configured;
}
