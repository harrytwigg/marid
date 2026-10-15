import { beforeEach, describe, expect, it } from "vitest";
import { baseConfig, call, reg, stubMintingFetch } from "./helpers/talk-route-harness.js";
import type { JinnConfig } from "../../shared/types.js";
import type { RealtimeUsage } from "../../shared/voice.js";

let config: JinnConfig;

beforeEach(() => {
  config = baseConfig();
  stubMintingFetch();
});

/** 1000 input audio tokens at $32/1M plus 1000 output audio at $64/1M. */
const ONE_TURN_USD = 0.096;

function usage(over: Partial<RealtimeUsage> = {}): RealtimeUsage {
  return {
    inputAudioTokens: 1000,
    outputAudioTokens: 1000,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedInputAudioTokens: 0,
    cachedInputTextTokens: 0,
    ...over,
  };
}

async function open() {
  const res = await call(config, "POST", "/api/talk/sessions");
  expect(res.status).toBe(201);
  return res.body;
}

function postTurn(id: string, transcript = "a short thing said out loud") {
  return call(config, "POST", `/api/talk/sessions/${id}/turn`, { usage: usage(), transcript });
}

async function reportTotal(): Promise<number> {
  const res = await call(config, "GET", "/api/cost/report");
  return (res.body.total as { cost: number }).cost;
}

describe("turn accounting", () => {
  it("raises the session's spend by the priced amount and shows it in the cost report", async () => {
    const id = (await open()).id as string;
    const before = await reportTotal();

    const turn = await postTurn(id);
    expect(turn.status).toBe(200);
    expect(turn.body.pricingKnown).toBe(true);
    expect(turn.body.costUsd as number).toBeCloseTo(ONE_TURN_USD, 6);
    expect(turn.body.spendUsd as number).toBeCloseTo(ONE_TURN_USD, 6);

    expect(await reportTotal()).toBeCloseTo(before + ONE_TURN_USD, 6);
    const status = await call(config, "GET", `/api/talk/sessions/${id}`);
    expect(status.body.spendUsd as number).toBeCloseTo(ONE_TURN_USD, 6);
  });

  it("adds again for a second identical turn: the payload is a delta, not a total", async () => {
    const id = (await open()).id as string;
    await postTurn(id);
    const second = await postTurn(id);
    expect(second.body.spendUsd as number).toBeCloseTo(ONE_TURN_USD * 2, 6);
  });

  it("flags an unpriceable model instead of reporting a free turn", async () => {
    // The unversioned alias: the provider chooses the version, so the gateway
    // cannot name what it is billing for.
    config.realtime!.model = "gpt-realtime";
    const id = (await open()).id as string;

    const turn = await postTurn(id);
    expect(turn.body.pricingKnown).toBe(false);
    expect(turn.body.costUsd).toBe(0);
    expect((await call(config, "GET", `/api/talk/sessions/${id}`)).body.pricingKnown).toBe(false);
  });

  it("rejects a malformed usage payload with 400 rather than billing zero", async () => {
    const id = (await open()).id as string;
    const bad = await call(config, "POST", `/api/talk/sessions/${id}/turn`, {
      usage: { ...usage(), outputAudioTokens: -5 },
    });
    expect(bad.status).toBe(400);
    const missing = await call(config, "POST", `/api/talk/sessions/${id}/turn`, { usage: {} });
    expect(missing.status).toBe(400);
  });

  it("prices image input and keeps one bounded visual receipt in the turn audit", async () => {
    const id = (await open()).id as string;
    const receipt = {
      requestKey: "item-user-1",
      contextRevision: 9,
      reason: "workflow-graph-spatial-layout",
      bytes: 3,
      width: 900,
      height: 600,
      estimatedImageTokens: 765,
      latencyMs: 24,
    };
    const turn = await call(config, "POST", `/api/talk/sessions/${id}/turn`, {
      usage: { ...usage(), inputImageTokens: 1000, cachedInputImageTokens: 0 },
      transcript: "The left node is Build.",
      visualReceipts: [receipt, receipt],
    });

    expect(turn.status).toBe(200);
    expect(turn.body.costUsd as number).toBeCloseTo(ONE_TURN_USD + 0.005, 6);
    const status = await call(config, "GET", `/api/talk/sessions/${id}`);
    expect(status.body.turns).toEqual([
      expect.objectContaining({ visualReceipts: [expect.objectContaining(receipt)] }),
    ]);
  });
});

describe("rolling context truncation", () => {
  /** 4000 estimated tokens against the 6000-token budget, so two turns overflow. */
  const bigTurn = "x".repeat(16_000);

  it("drops oldest first, counts the drop, and keeps the newest turn", async () => {
    const opened = await open();
    const id = opened.id as string;
    expect(opened.contextBudgetTokens).toBe(6000);

    const first = await postTurn(id, `${bigTurn}one`);
    expect(first.body.truncatedTurns).toBe(0);

    const second = await postTurn(id, `${bigTurn}two`);
    expect(second.body.truncatedTurns).toBe(1);
    expect(second.body.contextTokens as number).toBeLessThanOrEqual(6000);

    const status = await call(config, "GET", `/api/talk/sessions/${id}`);
    const turns = status.body.turns as Array<{ text: string }>;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text.endsWith("two")).toBe(true);
    expect(status.body.truncatedTurns).toBe(1);
  });

  it("suggests a handoff for a heavy turn and stays quiet for a light one", async () => {
    const id = (await open()).id as string;
    expect((await postTurn(id, "quick question")).body.handoffSuggested).toBe(false);
    expect((await postTurn(id, bigTurn)).body.handoffSuggested).toBe(true);
  });
});

describe("handoff to a text session", () => {
  it("spawns a real session with the talk session as its parent", async () => {
    const opened = await open();
    const id = opened.id as string;
    const parentSessionId = opened.sessionId as string;

    const res = await call(config, "POST", `/api/talk/sessions/${id}/handoff`, {
      prompt: "Draft the release notes and list every change since the last tag.",
    });
    expect(res.status).toBe(201);

    const spawnedId = res.body.sessionId as string;
    const spawned = reg.getSession(spawnedId);
    expect(spawned).toBeDefined();
    expect(spawned!.parentSessionId).toBe(parentSessionId);
    expect(res.body.parentSessionId).toBe(parentSessionId);
    // A child gets the child rule: the talk session has no mode, so the default (fallback) gives auto-resume.
    expect(spawned!.fallbackMode).toBe("auto-resume");
  });

  it("rejects an empty prompt with 400", async () => {
    const id = (await open()).id as string;
    expect((await call(config, "POST", `/api/talk/sessions/${id}/handoff`, { prompt: "   " })).status).toBe(400);
  });
});

describe("heartbeat", () => {
  it("answers with the session so the client can see it is still live", async () => {
    const id = (await open()).id as string;
    const res = await call(config, "POST", `/api/talk/sessions/${id}/heartbeat`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("live");
    expect(res.body.lastSeenAt as number).toBeGreaterThan(0);
  });
});
