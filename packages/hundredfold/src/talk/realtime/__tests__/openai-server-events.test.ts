/**
 * Pins how the OpenAI realtime adapter translates server frames into
 * `RealtimeEvent`s once a session is up: audio, transcripts, tool calls,
 * cancellation attribution, and the usage it accumulates across turns.
 *
 * Connect and disconnect are pinned separately in openai-session-setup.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports below, so the fake has to be pulled in
// from inside the factory instead of through this file's import bindings.
vi.mock("ws", async () => ({ default: (await import("./helpers/fake-realtime-socket.js")).FakeSocket }));

const { connected, lastSocket, receive, resetSocket, sentTypes } = await import(
  "./helpers/fake-realtime-socket.js"
);
const { priceTurn } = await import("../../session/pricing.js");

beforeEach(() => {
  resetSocket();
});

describe("OpenAI realtime server events", () => {
  it("decodes assistant audio deltas to raw PCM", async () => {
    const { events } = await connected();
    const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    receive({ type: "response.output_audio.delta", delta: pcm.toString("base64") });

    expect(events).toEqual([{ type: "audio", audio: pcm }]);
  });

  it("reports VAD speech boundaries", async () => {
    const { events } = await connected();

    receive({ type: "input_audio_buffer.speech_started" });
    receive({ type: "input_audio_buffer.speech_stopped" });

    expect(events).toEqual([{ type: "speech_started" }, { type: "speech_stopped" }]);
  });

  it("separates streaming and final transcripts by role", async () => {
    const { events } = await connected();

    receive({ type: "response.output_audio_transcript.delta", delta: "Hel" });
    receive({ type: "response.output_audio_transcript.done", transcript: "Hello." });
    receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hi there." });

    expect(events).toEqual([
      { type: "transcript", role: "assistant", text: "Hel", final: false },
      { type: "transcript", role: "assistant", text: "Hello.", final: true },
      { type: "transcript", role: "user", text: "Hi there.", final: true },
    ]);
  });

  it("surfaces tool calls with the id needed to answer them", async () => {
    const { provider, events } = await connected();

    receive({
      type: "response.function_call_arguments.done",
      call_id: "call_42",
      name: "list_todos",
      arguments: '{"status":"open"}',
    });
    provider.sendToolResult("call_42", '{"count":3}');

    expect(events).toEqual([
      { type: "tool_call", callId: "call_42", name: "list_todos", arguments: '{"status":"open"}' },
    ]);
    const item = JSON.parse(lastSocket().sent[1]) as { item: Record<string, unknown> };
    expect(item.item).toEqual({ type: "function_call_output", call_id: "call_42", output: '{"count":3}' });
    expect(sentTypes()).toEqual(["session.update", "conversation.item.create", "response.create"]);
  });

  it("commits a push-to-talk turn and asks for a response", async () => {
    const { provider } = await connected({ turnDetection: "none" });

    provider.sendAudio(Buffer.from([0x10, 0x20]));
    provider.commitAudio();

    expect(sentTypes()).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
      "response.create",
    ]);
  });

  it("accumulates usage across turns, keeping the cached tokens split by modality", async () => {
    const { provider, events } = await connected();
    const usage = {
      input_token_details: {
        text_tokens: 5,
        audio_tokens: 100,
        cached_tokens: 3,
        cached_tokens_details: { text_tokens: 2, audio_tokens: 1 },
      },
      output_token_details: { text_tokens: 9, audio_tokens: 17 },
    };

    receive({ type: "response.done", response: { status: "completed", usage } });
    receive({ type: "response.done", response: { status: "completed", usage } });

    expect(provider.usage()).toEqual({
      inputAudioTokens: 200,
      inputImageTokens: 0,
      inputTextTokens: 10,
      cachedInputAudioTokens: 2,
      cachedInputImageTokens: 0,
      cachedInputTextTokens: 4,
      outputAudioTokens: 34,
      outputTextTokens: 18,
    });
    expect(events.at(-1)).toEqual({ type: "turn_done", usage: provider.usage() });
  });

  it("bills cached tokens the server did not split at the rate that cannot under-report", async () => {
    // On the mini model cached audio costs $0.30 against text's $0.06, but a
    // cached audio token also cancels a $10 input token where a cached text one
    // cancels $0.60. So text is the higher bill, not audio: 60 audio at $10 plus
    // 15 fresh text at $0.60 plus 25 cached text at $0.06 is $0.0006105 per 1M,
    // against the $0.0003815 that charging audio would have reported.
    const { provider } = await connected({ model: "gpt-realtime-2.1-mini" });

    receive({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_token_details: { text_tokens: 40, audio_tokens: 60, cached_tokens: 25 } },
      },
    });

    expect(provider.usage()).toMatchObject({ cachedInputAudioTokens: 0, cachedInputTextTokens: 25 });
    expect(priceTurn("gpt-realtime-2.1-mini", provider.usage()).costUsd).toBeCloseTo(0.0006105, 9);
  });

  it("spills an unattributed cached count past the input count it cannot fit in", async () => {
    // Only 10 text tokens were sent, so at most 10 of the 25 can be cached text;
    // the other 15 have to be audio for the cached counts to stay subsets.
    const { provider } = await connected({ model: "gpt-realtime-2.1-mini" });

    receive({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_token_details: { text_tokens: 10, audio_tokens: 60, cached_tokens: 25 } },
      },
    });

    expect(provider.usage()).toMatchObject({ cachedInputAudioTokens: 15, cachedInputTextTokens: 10 });
  });

  it("attributes an unrequested cancellation to barge-in", async () => {
    const { events } = await connected();

    receive({ type: "response.done", response: { status: "cancelled" } });

    expect(events).toEqual([{ type: "response_cancelled", reason: "barge_in" }]);
  });

  it("attributes a cancellation we asked for to the client, once", async () => {
    const { provider, events } = await connected();

    provider.interrupt();
    receive({ type: "response.done", response: { status: "cancelled" } });
    receive({ type: "response.done", response: { status: "cancelled" } });

    expect(sentTypes()).toContain("response.cancel");
    expect(events).toEqual([
      { type: "response_cancelled", reason: "client" },
      { type: "response_cancelled", reason: "barge_in" },
    ]);
  });

  it("passes through API errors and malformed frames", async () => {
    const { events } = await connected();

    receive({ type: "error", error: { message: "session expired" } });
    lastSocket().emit("message", Buffer.from("not json"));

    expect(events).toEqual([
      { type: "error", message: "session expired" },
      { type: "error", message: "OpenAI realtime sent a frame that is not JSON" },
    ]);
  });

  it("ignores the item-lifecycle events it has no equivalent for", async () => {
    const { events } = await connected();

    receive({ type: "session.created" });
    receive({ type: "response.content_part.added" });
    receive({ type: "conversation.item.done" });

    expect(events).toEqual([]);
  });
});
