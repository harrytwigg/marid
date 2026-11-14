/**
 * Pins how the OpenAI realtime adapter opens and closes a session: the `session`
 * payload it builds, the handshake it holds open until the server acknowledges
 * that payload, and the guards against connecting or sending out of order.
 *
 * Server-event translation is pinned separately in openai-server-events.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports below, so the fake has to be pulled in
// from inside the factory instead of through this file's import bindings.
vi.mock("ws", async () => ({ default: (await import("./helpers/fake-realtime-socket.js")).FakeSocket }));

const { connected, lastSocket, realtimeAdapter, receive, resetSocket, sentTypes, settled } = await import(
  "./helpers/fake-realtime-socket.js"
);
const { createOpenAiRealtimeProvider, buildSessionPayload } = await realtimeAdapter();

beforeEach(() => {
  resetSocket();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type InputAudioPayload = {
  noise_reduction: { type: string };
  transcription: { model: string };
  turn_detection: Record<string, unknown> | null;
};

function inputAudio(options: Parameters<typeof buildSessionPayload>[0], createResponse = true): InputAudioPayload {
  const payload = buildSessionPayload(options, createResponse) as { audio: { input: InputAudioPayload } };
  return payload.audio.input;
}

describe("buildSessionPayload", () => {
  it("defaults direct provider sessions to the driving VAD and noise filter", () => {
    expect(inputAudio({})).toMatchObject({
      noise_reduction: { type: "far_field" },
      transcription: { model: "gpt-4o-mini-transcribe" },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
    });
  });

  it.each(["low", "medium", "high", "auto"] as const)(
    "maps semantic VAD eagerness %s",
    (eagerness) => {
      expect(inputAudio({ turnDetection: { type: "semantic_vad", eagerness } }).turn_detection).toEqual({
        type: "semantic_vad",
        eagerness,
        create_response: true,
        interrupt_response: true,
      });
    },
  );

  it("maps every tuned server VAD field, including a zero threshold", () => {
    expect(inputAudio({
      turnDetection: {
        type: "server_vad",
        threshold: 0,
        prefixPaddingMs: 450,
        silenceDurationMs: 900,
      },
    }).turn_detection).toEqual({
      type: "server_vad",
      threshold: 0,
      prefix_padding_ms: 450,
      silence_duration_ms: 900,
      create_response: true,
      interrupt_response: true,
    });
  });

  it.each(["near_field", "far_field"] as const)("maps %s input noise reduction", (noiseReduction) => {
    expect(inputAudio({ noiseReduction }).noise_reduction).toEqual({ type: noiseReduction });
  });

  it("keeps the legacy server VAD shorthand", () => {
    expect(inputAudio({ turnDetection: "server_vad" }).turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      interrupt_response: true,
    });
  });

  it("disables turn detection for push-to-talk", () => {
    expect(inputAudio({ turnDetection: "none" }).turn_detection).toBeNull();
  });

  it("omits the voice rather than sending an empty one", () => {
    expect(buildSessionPayload({})).not.toHaveProperty("audio.output.voice");
    const withVoice = buildSessionPayload({ voice: "marin" }) as { audio: { output: { voice: string } } };
    expect(withVoice.audio.output.voice).toBe("marin");
  });

  it("declares tools in the shape the API expects", () => {
    const payload = buildSessionPayload({
      tools: [{ name: "list_todos", description: "List open todos", parameters: { type: "object" } }],
    }) as { tools: Record<string, unknown>[] };
    expect(payload.tools).toEqual([
      { type: "function", name: "list_todos", description: "List open todos", parameters: { type: "object" } },
    ]);
  });
});

describe("OpenAI realtime session lifecycle", () => {
  it("rejects construction without an API key", () => {
    expect(() => createOpenAiRealtimeProvider({ apiKey: "" })).toThrow(/requires an API key/);
  });

  it("configures the session on connect and names the model in the URL", async () => {
    await connected({ model: "gpt-realtime-2.1" });

    expect(lastSocket().url).toContain("model=gpt-realtime-2.1");
    expect(sentTypes()).toEqual(["session.update"]);
    const update = JSON.parse(lastSocket().sent[0]!) as {
      session: { audio: { input: InputAudioPayload } };
    };
    expect(update.session.audio.input.turn_detection).toMatchObject({
      type: "semantic_vad",
      create_response: true,
    });
    expect(update.session.audio.input.noise_reduction).toEqual({ type: "far_field" });
  });

  it("binds browser credentials to client-gated responses", async () => {
    let requestBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return {
        ok: true,
        json: async () => ({ value: "ephemeral-test", expires_at: 2_000_000_000 }),
      };
    }));
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });

    await provider.mintEphemeralToken();

    const input = (requestBody as {
      session: { audio: { input: InputAudioPayload } };
    }).session.audio.input;
    expect(input.turn_detection).toMatchObject({
      type: "semantic_vad",
      eagerness: "medium",
      create_response: false,
      interrupt_response: true,
    });
    expect(input.noise_reduction).toEqual({ type: "far_field" });
  });

  it("forwards realtime config into the browser credential payload", async () => {
    let requestBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body));
      return {
        ok: true,
        json: async () => ({ value: "ephemeral-test", expires_at: 2_000_000_000 }),
      };
    }));
    const { createRealtimeProvider } = await import("../index.js");
    const provider = createRealtimeProvider({
      provider: "openai",
      apiKey: "test-key",
      turnDetection: { type: "semantic_vad", eagerness: "high" },
      noiseReduction: "near_field",
    });

    await provider.mintEphemeralToken();

    const input = (requestBody as {
      session: { audio: { input: InputAudioPayload } };
    }).session.audio.input;
    expect(input.turn_detection).toMatchObject({
      type: "semantic_vad",
      eagerness: "high",
      create_response: false,
    });
    expect(input.noise_reduction).toEqual({ type: "near_field" });
  });

  it("stays pending until the server acknowledges the session", async () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    const connecting = provider.connect({ turnDetection: "none" });

    lastSocket().emit("open");
    expect(sentTypes()).toEqual(["session.update"]);
    // An open socket is not a configured session: audio sent now would be
    // handled under the default server-VAD session, not this one.
    expect(await settled(connecting)).toBe(false);

    receive({ type: "session.updated" });
    expect(await settled(connecting)).toBe(true);
    await expect(connecting).resolves.toBeUndefined();
  });

  it("rejects the connect when the server refuses the session config", async () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    const connecting = provider.connect();

    lastSocket().emit("open");
    receive({ type: "error", error: { message: "unknown voice" } });

    await expect(connecting).rejects.toThrow(/unknown voice/);
  });

  it("rejects the connect when the socket closes before the acknowledgement", async () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    const connecting = provider.connect();

    lastSocket().emit("open");
    lastSocket().close();

    await expect(connecting).rejects.toThrow(/closed before the session was configured/);
  });

  it("refuses a second connect on the same provider", async () => {
    const { provider } = await connected();
    expect(() => provider.connect()).toThrow(/already connected/);
  });

  it("refuses to send before connecting", () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    expect(() => provider.sendAudio(Buffer.from([0, 1]))).toThrow(/not connected/);
  });

  it("reports the close and drops the socket", async () => {
    const { provider, events } = await connected();

    provider.disconnect();

    expect(events).toEqual([{ type: "closed", reason: "code 1000" }]);
    expect(() => provider.sendAudio(Buffer.from([0]))).toThrow(/not connected/);
  });

  it("tolerates disconnecting a provider that never connected", () => {
    const provider = createOpenAiRealtimeProvider({ apiKey: "test-key" });
    expect(() => provider.disconnect()).not.toThrow();
  });
});
