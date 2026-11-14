import { beforeEach, describe, expect, it } from "vitest";
import { baseConfig, call, reg, stubMintingFetch } from "./helpers/talk-route-harness.js";
import type { HundredfoldConfig } from "../../shared/types.js";
import type { RealtimeUsage } from "../../shared/voice.js";
import { createWorkItem } from "../../work-items/store.js";

let config: HundredfoldConfig;

beforeEach(() => {
  config = baseConfig();
  stubMintingFetch();
});

const usage = (): RealtimeUsage => ({
  inputAudioTokens: 12,
  outputAudioTokens: 8,
  inputTextTokens: 0,
  outputTextTokens: 0,
  cachedInputAudioTokens: 0,
  cachedInputTextTokens: 0,
});

async function open() {
  const response = await call(config, "POST", "/api/talk/sessions", { browserInstanceId: "browser-persistence-1" });
  expect(response.status).toBe(201);
  return response.body as { id: string; sessionId: string; credentialGeneration: number };
}

describe("Talk is a normal durable chat", () => {
  it("stores final user and assistant speech once with bounded Talk metadata", async () => {
    const opened = await open();
    const evidence = {
      browserInstanceId: "browser-persistence-1",
      credentialGeneration: opened.credentialGeneration,
      providerItemId: "operator-item-1",
      providerEventId: "operator-event-1",
      transcript: "Return to the cobalt release decision",
    };

    expect((await call(config, "POST", `/api/talk/sessions/${opened.id}/transcript`, evidence)).status).toBe(200);
    expect((await call(config, "POST", `/api/talk/sessions/${opened.id}/transcript`, evidence)).status).toBe(200);
    const turn = {
      usage: usage(),
      transcript: "The release decision is still waiting on verification.",
      providerResponseId: "response-1",
      providerItemId: "assistant-item-1",
    };
    expect((await call(config, "POST", `/api/talk/sessions/${opened.id}/turn`, turn)).status).toBe(200);
    expect((await call(config, "POST", `/api/talk/sessions/${opened.id}/turn`, turn)).status).toBe(200);

    const messages = reg.getMessages(opened.sessionId);
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", evidence.transcript],
      ["assistant", turn.transcript],
    ]);
    expect(messages[0]?.meta?.talk).toMatchObject({ kind: "transcript", providerItemId: "operator-item-1" });
    expect(messages[1]?.meta?.talk).toMatchObject({ kind: "turn", providerResponseId: "response-1" });
    expect(reg.searchMessages("cobalt release", 20, { sessionId: opened.sessionId })).toHaveLength(1);
    expect(reg.searchSessions("cobalt release").map((session) => session.id)).toContain(opened.sessionId);
  });

  it("keeps the normal source chat after the Talk runtime closes", async () => {
    const opened = await open();
    await call(config, "POST", `/api/talk/sessions/${opened.id}/transcript`, {
      browserInstanceId: "browser-persistence-1",
      credentialGeneration: opened.credentialGeneration,
      providerItemId: "operator-item-close",
      providerEventId: "operator-event-close",
      transcript: "Keep this completed Talk history searchable",
    });
    expect((await call(config, "DELETE", `/api/talk/sessions/${opened.id}`)).status).toBe(200);

    expect(reg.getSession(opened.sessionId)?.source).toBe("talk");
    expect(reg.getMessages(opened.sessionId).map((message) => message.content)).toEqual([
      "Keep this completed Talk history searchable",
    ]);
  });

  it("renders one verified control receipt as a normal chat tool message", async () => {
    const opened = await open();
    const todo = createWorkItem({ title: "Record the durable Talk receipt" });
    const body = {
      providerCallId: "control-receipt-1",
      tool: "talk_comment_todo",
      arguments: JSON.stringify({ id: todo.id, body: "Verified once" }),
    };
    await call(config, "POST", `/api/talk/sessions/${opened.id}/control`, body);
    await call(config, "POST", `/api/talk/sessions/${opened.id}/control`, body);

    expect(reg.getMessages(opened.sessionId)).toMatchObject([{
      role: "assistant",
      content: "Completed talk_comment_todo.",
      toolCall: "talk_comment_todo",
      toolId: "control-receipt-1",
      meta: { talk: { kind: "control-receipt", verified: true } },
    }]);
  });
});
