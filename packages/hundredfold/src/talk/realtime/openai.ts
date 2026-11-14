/**
 * OpenAI Realtime adapter — implementation 1 of {@link RealtimeProvider}.
 *
 * Speaks the GA `gpt-realtime` WebSocket protocol. Server-side pipelines use a
 * WebSocket carrying the account key; browser clients get an ephemeral token
 * from {@link OpenAiRealtimeProvider.mintEphemeralToken} and open their own
 * WebRTC connection, so the account key never reaches a browser.
 *
 * Constructed only through `createRealtimeProvider` in ./index.ts.
 */
import WebSocket from "ws";
import type { JsonObject } from "../../shared/types.js";
import type {
  RealtimeEphemeralToken,
  RealtimeEvent,
  RealtimeProvider,
  RealtimeSessionOptions,
  RealtimeUsage,
} from "../../shared/voice.js";
import { addUsage, emptyUsage, type OpenAiUsage } from "./openai-usage.js";
import { buildSessionPayload, DEFAULT_REALTIME_MODEL } from "./openai-session-payload.js";

/**
 * The voices this provider will accept on a session.
 *
 * Confirmed against the OpenAI Realtime voice list for `gpt-realtime`. It lives
 * here rather than in the web bundle because it is provider knowledge: a second
 * provider brings its own list, and a browser hard-coding one would be wrong
 * the moment `realtime.provider` changes.
 */
export const OPENAI_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

export { buildSessionPayload } from "./openai-session-payload.js";

const REALTIME_WS_URL = "wss://api.openai.com/v1/realtime";
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
/** The API's own default. Its documented range is 10-7200 seconds. */
const EPHEMERAL_TOKEN_TTL_SECONDS = 600;

export interface OpenAiRealtimeOptions {
  apiKey: string;
  /** Defaults applied to every session; per-call options override them. */
  session?: RealtimeSessionOptions;
}

class OpenAiRealtimeProvider implements RealtimeProvider {
  readonly name = "openai";

  private readonly apiKey: string;
  private readonly defaults: RealtimeSessionOptions;
  private readonly handlers: ((event: RealtimeEvent) => void)[] = [];
  private readonly total = emptyUsage();
  private socket: WebSocket | null = null;
  /** The model this session actually connected on, which is what its usage prices against. */
  private model = DEFAULT_REALTIME_MODEL;
  /** Set by `interrupt()` so the next cancellation is attributed to us, not to VAD. */
  private cancelledByClient = false;
  /** Settles the `connect()` promise once the server acknowledges the session. */
  private configuring: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(options: OpenAiRealtimeOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAI realtime provider requires an API key — set realtime.apiKey in config.yaml (it accepts ${ENV_VAR})");
    }
    this.apiKey = options.apiKey;
    this.defaults = options.session ?? {};
  }

  async mintEphemeralToken(options: RealtimeSessionOptions = {}): Promise<RealtimeEphemeralToken> {
    const response = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: EPHEMERAL_TOKEN_TTL_SECONDS },
        session: buildSessionPayload({ ...this.defaults, ...options }, false),
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI refused to mint a realtime client secret: ${response.status} ${await response.text()}`);
    }
    const minted = (await response.json()) as { value?: string; expires_at?: number };
    if (!minted.value || !minted.expires_at) {
      throw new Error("OpenAI returned a realtime client secret without a value or an expiry");
    }
    return { value: minted.value, expiresAt: minted.expires_at };
  }

  connect(options: RealtimeSessionOptions = {}): Promise<void> {
    if (this.socket) throw new Error("This realtime provider is already connected — construct a second one for a second session");
    const session = { ...this.defaults, ...options };
    this.model = session.model ?? DEFAULT_REALTIME_MODEL;
    const socket = new WebSocket(`${REALTIME_WS_URL}?model=${encodeURIComponent(this.model)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.socket = socket;
    socket.on("message", (raw: Buffer) => this.receive(raw));
    socket.on("close", (code: number, reason: Buffer) => {
      this.socket = null;
      const detail = reason.toString() || `code ${code}`;
      this.settleConfiguring(new Error(`the socket closed before the session was configured: ${detail}`));
      this.emit({ type: "closed", reason: detail });
    });
    return this.awaitConfigured(socket, session);
  }

  /**
   * Resolves once the server has acknowledged the session with `session.updated`,
   * not merely once the update was written. Anything sent before that ack is
   * handled under the default session, where server VAD is on and a
   * push-to-talk `commitAudio` has nothing to commit.
   */
  private awaitConfigured(socket: WebSocket, session: RealtimeSessionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.configuring = { resolve, reject };
      socket.once("error", (error: Error) => {
        this.socket = null;
        this.settleConfiguring(new Error(`Could not open the OpenAI realtime socket: ${error.message}`));
      });
      socket.once("open", () => {
        socket.on("error", (error: Error) => this.emit({ type: "error", message: error.message }));
        this.send({ type: "session.update", session: buildSessionPayload(session) });
      });
    });
  }

  /** Settle a pending `connect()` exactly once. `failure` undefined means success. */
  private settleConfiguring(failure?: Error): void {
    const pending = this.configuring;
    if (!pending) return;
    this.configuring = null;
    if (failure) pending.reject(failure);
    else pending.resolve();
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }

  sendAudio(pcm: Buffer): void {
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }

  interrupt(): void {
    this.cancelledByClient = true;
    this.send({ type: "response.cancel" });
  }

  sendToolResult(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    this.send({ type: "response.create" });
  }

  on(handler: (event: RealtimeEvent) => void): void {
    this.handlers.push(handler);
  }

  usage(): RealtimeUsage {
    return { ...this.total };
  }

  private send(message: JsonObject): void {
    if (!this.socket) throw new Error("This realtime provider is not connected — call connect() first");
    this.socket.send(JSON.stringify(message));
  }

  private emit(event: RealtimeEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private receive(raw: Buffer): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      this.emit({ type: "error", message: "OpenAI realtime sent a frame that is not JSON" });
      return;
    }
    if (message.type === "session.updated") this.settleConfiguring();
    const event = this.translate(message);
    if (!event) return;
    // A rejected session config arrives as an ordinary error frame; without this
    // it would be reported while connect() waited for an ack that never comes.
    if (event.type === "error") this.settleConfiguring(new Error(event.message));
    this.emit(event);
  }

  /** Map one OpenAI server event onto the provider-neutral vocabulary. Events
   *  with no neutral equivalent (item lifecycle, content parts) return null. */
  private translate(message: Record<string, unknown>): RealtimeEvent | null {
    switch (message.type) {
      case "response.output_audio.delta":
        return { type: "audio", audio: Buffer.from(String(message.delta), "base64") };
      case "response.output_audio_transcript.delta":
        return { type: "transcript", role: "assistant", text: String(message.delta), final: false };
      case "response.output_audio_transcript.done":
        return { type: "transcript", role: "assistant", text: String(message.transcript), final: true };
      case "conversation.item.input_audio_transcription.completed":
        return { type: "transcript", role: "user", text: String(message.transcript), final: true };
      case "input_audio_buffer.speech_started":
        return { type: "speech_started" };
      case "input_audio_buffer.speech_stopped":
        return { type: "speech_stopped" };
      case "response.function_call_arguments.done":
        return {
          type: "tool_call",
          callId: String(message.call_id),
          name: String(message.name),
          arguments: String(message.arguments),
        };
      case "response.done":
        return this.completeTurn(message.response as Record<string, unknown> | undefined);
      case "error":
        return { type: "error", message: describeError(message.error) };
      default:
        return null;
    }
  }

  /** A cancelled response is a barge-in unless we asked for the cancellation. */
  private completeTurn(response: Record<string, unknown> | undefined): RealtimeEvent {
    if (response?.usage) addUsage(this.total, response.usage as OpenAiUsage, this.model);
    if (response?.status === "cancelled") {
      const reason = this.cancelledByClient ? "client" : "barge_in";
      this.cancelledByClient = false;
      return { type: "response_cancelled", reason };
    }
    return { type: "turn_done", usage: this.usage() };
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "OpenAI realtime reported an error with no message";
}

export function createOpenAiRealtimeProvider(options: OpenAiRealtimeOptions): RealtimeProvider {
  return new OpenAiRealtimeProvider(options);
}
