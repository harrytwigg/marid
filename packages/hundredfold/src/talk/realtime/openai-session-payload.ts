import type { JsonObject } from "../../shared/types.js";
import type { RealtimeSessionOptions, RealtimeTurnDetection } from "../../shared/voice.js";

export const DEFAULT_REALTIME_MODEL = "gpt-realtime";

function turnDetectionPayload(mode: RealtimeTurnDetection | undefined, createResponse: boolean): JsonObject | null {
  if (mode === "none") return null;
  if (mode === undefined) {
    return {
      type: "semantic_vad",
      eagerness: "medium",
      create_response: createResponse,
      interrupt_response: true,
    };
  }
  if (mode === "server_vad") {
    return { type: "server_vad", create_response: createResponse, interrupt_response: true };
  }
  if (mode.type === "semantic_vad") {
    return {
      type: "semantic_vad",
      ...(mode.eagerness !== undefined ? { eagerness: mode.eagerness } : {}),
      create_response: createResponse,
      interrupt_response: true,
    };
  }
  return {
    type: "server_vad",
    ...(mode.threshold !== undefined ? { threshold: mode.threshold } : {}),
    ...(mode.prefixPaddingMs !== undefined ? { prefix_padding_ms: mode.prefixPaddingMs } : {}),
    ...(mode.silenceDurationMs !== undefined ? { silence_duration_ms: mode.silenceDurationMs } : {}),
    create_response: createResponse,
    interrupt_response: true,
  };
}

/** The `session` object shared by the WebSocket handshake and token minting. */
export function buildSessionPayload(options: RealtimeSessionOptions, createResponse = true): JsonObject {
  const audio: JsonObject = {
    input: {
      format: { type: "audio/pcm", rate: 24000 },
      noise_reduction: { type: options.noiseReduction ?? "far_field" },
      transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: turnDetectionPayload(options.turnDetection, createResponse),
    },
    output: {
      format: { type: "audio/pcm", rate: 24000 },
      ...(options.voice ? { voice: options.voice } : {}),
    },
  };
  return {
    type: "realtime",
    model: options.model ?? DEFAULT_REALTIME_MODEL,
    output_modalities: ["audio"],
    audio,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.tools ? { tools: options.tools.map((tool) => ({ type: "function", ...tool })) } : {}),
  };
}
