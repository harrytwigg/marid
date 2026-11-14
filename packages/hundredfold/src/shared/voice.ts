/**
 * The voice stack's types: speech-to-text input, read-aloud TTS output, and the
 * speech-to-speech realtime seam. `HundredfoldConfig` in types.ts imports the three
 * config shapes back; talk/realtime implements the provider interface.
 */
import type { JsonObject } from "./types.js";

/** Short-lived credential a browser client uses to open its own realtime
 *  connection, so the account key never leaves the gateway. */
export interface RealtimeEphemeralToken {
  value: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** Token counts as the provider reports them, accumulated over a session. Audio and text are priced
 *  apart, cached tiers included, and a cached count is a subset of the input count it names. */
export interface RealtimeUsage {
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  cachedInputAudioTokens: number;
  cachedInputTextTokens: number;
  /** Image tokens are optional for adapters that cannot receive images. */
  inputImageTokens?: number;
  cachedInputImageTokens?: number;
}

/** A tool the model may call mid-conversation. `parameters` is a JSON Schema. */
export interface RealtimeTool {
  name: string;
  description: string;
  parameters: JsonObject;
}

/** How quickly semantic VAD decides that the user has finished a thought. */
export type RealtimeVadEagerness = "low" | "medium" | "high" | "auto";

export interface RealtimeSemanticVadConfig {
  type: "semantic_vad";
  eagerness?: RealtimeVadEagerness;
}

export interface RealtimeServerVadConfig {
  type: "server_vad";
  /** Activation threshold in the provider's 0..1 range. */
  threshold?: number;
  /** Audio retained before detected speech starts. */
  prefixPaddingMs?: number;
  /** Silence required before detected speech stops. */
  silenceDurationMs?: number;
}

/** Who decides a user turn has ended. The `server_vad` string remains the
 *  untuned legacy shorthand; `none` leaves turn commits to the caller. */
export type RealtimeTurnDetection =
  | "server_vad"
  | "none"
  | RealtimeSemanticVadConfig
  | RealtimeServerVadConfig;

/** Input filtering matched to the microphone's distance from the speaker. */
export type RealtimeNoiseReduction = "near_field" | "far_field";

export interface RealtimeSessionOptions {
  model?: string;
  voice?: string;
  /** System prompt for the voice session. */
  instructions?: string;
  tools?: RealtimeTool[];
  turnDetection?: RealtimeTurnDetection;
  noiseReduction?: RealtimeNoiseReduction;
}

/** Everything a caller observes on a live realtime session. */
export type RealtimeEvent =
  /** A chunk of assistant speech, PCM16 mono at the provider's session rate. */
  | { type: "audio"; audio: Buffer }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  /** VAD heard the user start talking — the caller's cue to duck playback. */
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  /** The assistant turn was cut short. `barge_in` means the user talked over it. */
  | { type: "response_cancelled"; reason: "barge_in" | "client" }
  | { type: "tool_call"; callId: string; name: string; arguments: string }
  /** The assistant turn finished; `usage` is the session total after this turn. */
  | { type: "turn_done"; usage: RealtimeUsage }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string };

/**
 * A speech-to-speech provider (OpenAI Realtime, Gemini Live).
 *
 * One instance owns one connection. Implemented by talk/realtime/openai.ts and
 * constructed only through `createRealtimeProvider`; talk/realtime/README.md
 * writes up Gemini Live against this same interface.
 */
export interface RealtimeProvider {
  readonly name: string;
  /**
   * Mint a short-lived client credential. Callable without connecting — the
   * gateway hands the token to a browser that opens its own connection.
   */
  mintEphemeralToken(options?: RealtimeSessionOptions): Promise<RealtimeEphemeralToken>;
  /** Open the session's transport and configure it. Rejects if it cannot connect. */
  connect(options?: RealtimeSessionOptions): Promise<void>;
  /** Close the transport. Safe to call when never connected or already closed. */
  disconnect(): void;
  /** Append captured microphone audio (PCM16 mono) to the current user turn. */
  sendAudio(pcm: Buffer): void;
  /** End the user turn and ask for a response. Required under `turnDetection: "none"`. */
  commitAudio(): void;
  /** Barge-in: abandon the in-flight assistant turn immediately. */
  interrupt(): void;
  /** Answer a `tool_call` event. `output` is the JSON-encoded result. */
  sendToolResult(callId: string, output: string): void;
  /** Subscribe to session events. Later subscribers do not replace earlier ones. */
  on(handler: (event: RealtimeEvent) => void): void;
  /** Token totals observed so far this session. */
  usage(): RealtimeUsage;
}

export interface SttConfig {
  enabled?: boolean;
  model?: string;
  /** @deprecated Use `languages` instead. Kept for backwards compat. */
  language?: string;
  languages?: string[];
}

export interface TalkConfig {
  /** @deprecated The Talk orchestrator is retired. Kept for patch-release source compatibility. */
  enabled?: boolean;
  /** @deprecated The Talk orchestrator is retired. Kept for patch-release source compatibility. */
  engine?: string;
  /** @deprecated The Talk orchestrator is retired. Kept for patch-release source compatibility. */
  orchestratorModel?: string;
  kokoro?: {
    voice?: string;
    modelDir?: string;
    sidecarPort?: number;
  };
}

export interface RealtimeConfig {
  /** Provider name. `createRealtimeProvider` throws on one it does not know. */
  provider?: string;
  model?: string;
  /** The provider's account key. Supports `${ENV_VAR}` indirection so the key
   *  can live in the environment rather than in config.yaml. */
  apiKey?: string;
  voice?: string;
  turnDetection?: RealtimeTurnDetection;
  noiseReduction?: RealtimeNoiseReduction;
}
