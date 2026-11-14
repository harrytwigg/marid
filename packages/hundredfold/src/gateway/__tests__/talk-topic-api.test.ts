import { beforeEach, describe, expect, it } from "vitest";
import type { HundredfoldConfig } from "../../shared/types.js";
import { baseConfig, call, stubMintingFetch } from "./helpers/talk-route-harness.js";

let config: HundredfoldConfig;

beforeEach(() => {
  config = baseConfig();
  stubMintingFetch();
});

function screen(index: number) {
  const kind = index % 3 === 0 ? "workflow" : index % 2 === 0 ? "Todo" : "chat session";
  return {
    version: 1,
    revision: index,
    routeId: kind === "Todo" ? "todo" : kind === "workflow" ? "workflow" : "chat",
    path: `/surface/${index}`,
    params: {},
    filters: {},
    selection: { kind, id: `object-${index}` },
    capturedAt: new Date(index * 1_000).toISOString(),
    freshness: "complete",
    missing: [],
    title: `Topic ${index}`,
    selectedObject: {
      kind,
      id: `object-${index}`,
      title: `Topic ${index}`,
      status: "active",
      fields: {},
      relations: [],
      retrievalAnchor: { id: `object-${index}` },
    },
    visibleItems: [],
    controls: [],
    meaningfulText: `Verified state ${index}`,
    browserInstanceId: "browser-topic-test",
    focus: null,
    hidden: false,
    visualGaps: [],
  };
}

describe("Talk topic context API", () => {
  it("survives twelve topics, commitments, vague recall, and stale context replay", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions", { browserInstanceId: "browser-topic-test" });
    expect(opened.status).toBe(201);
    const id = String(opened.body.id);
    const identity = {
      browserInstanceId: "browser-topic-test",
      credentialGeneration: Number(opened.body.credentialGeneration),
    };

    const first = await call(config, "POST", `/api/talk/sessions/${id}/context`, { ...identity, screen: screen(1) });
    expect(first.body).toMatchObject({ topic: { label: "Topic 1" }, telemetry: { active: 1 } });
    const firstTopicId = String((first.body.topic as { id: string }).id);
    const controlPath = `/api/talk/sessions/${id}/control`;
    const remembered = await call(config, "POST", controlPath, {
      providerCallId: "remember-first-topic",
      tool: "talk_remember_topic",
      arguments: JSON.stringify({ goal: "Finish the review", decision: "Keep the staged rollout", unresolvedQuestion: "Who verifies it?" }),
    });
    expect(remembered.body).toMatchObject({ ok: true, verified: true });

    for (let index = 2; index <= 12; index += 1) {
      const observed = await call(config, "POST", `/api/talk/sessions/${id}/context`, { ...identity, screen: screen(index) });
      expect(observed.status).toBe(200);
    }
    const stale = await call(config, "POST", `/api/talk/sessions/${id}/context`, { ...identity, screen: screen(2) });
    expect(stale.body).toMatchObject({ topic: { label: "Topic 12" } });

    const recalled = await call(config, "POST", controlPath, {
      providerCallId: "recall-first-topic",
      tool: "talk_recall_topic",
      arguments: JSON.stringify({ reference: "go back to the first" }),
    });
    expect(recalled.body).toMatchObject({
      ok: true,
      data: { status: "resolved", topic: { id: firstTopicId, goal: "Finish the review",
        decisions: ["Keep the staged rollout"], unresolvedQuestions: ["Who verifies it?"] } },
      uiEffect: { navigate: "/surface/1" },
    });
    const status = await call(config, "GET", `/api/talk/sessions/${id}`);
    expect(status.body.topicTelemetry).toMatchObject({ active: 1, warm: 11 });
    expect(String(status.body.topicMemory)).toContain("Finish the review");
  });

  it("rejects context from another browser credential", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions", { browserInstanceId: "browser-topic-test" });
    const response = await call(config, "POST", `/api/talk/sessions/${String(opened.body.id)}/context`, {
      browserInstanceId: "different-browser",
      credentialGeneration: opened.body.credentialGeneration,
      screen: screen(1),
    });
    expect(response.status).toBe(409);
  });
});
