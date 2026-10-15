import { describe, expect, it } from "vitest";
import type { StreamDelta } from "../../shared/types.js";
import { MuseTurn, describeModelRetry, describeMuseToolCall, formatRetryDelay, museTurnCost, toolOutputText } from "../musecode-turn.js";

const SESSION = "01a13f8f-4840-7f30-92cd-aa7c6655b28c";
const TURN = "01a13f8f-48cb-7e8f-ade4-adb3e742c322";

function harness() {
  const deltas: StreamDelta[] = [];
  const usages: unknown[] = [];
  const turn = new MuseTurn(SESSION, { onStream: (d) => deltas.push(d), onUsage: (u) => usages.push(u) });
  turn.setTurnId(TURN);
  const feed = (method: string, params: Record<string, unknown> = {}) => turn.read(method, { sessionId: SESSION, ...params });
  return { turn, deltas, usages, feed };
}

const message = (itemId: string, fields: Record<string, unknown>) => ({ itemId, kind: "agentMessage", turnId: TURN, revision: 1, ...fields });

describe("MuseTurn: the answer", () => {
  it("streams text deltas and answers with the finalAnswer message", () => {
    const { turn, deltas, feed } = harness();
    feed("item/started", { item: message("m1", { status: "inProgress", text: "" }) });
    feed("item/delta", { itemId: "m1", field: "text", delta: "echo: " });
    feed("item/delta", { itemId: "m1", field: "text", delta: "hello" });
    feed("item/completed", { item: message("m1", { status: "completed", messagePhase: "finalAnswer", text: "echo: hello" }) });
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(deltas).toEqual([{ type: "text", content: "echo: " }, { type: "text", content: "hello" }]);
    expect(turn.result({ terminationReason: null })).toMatchObject({ sessionId: SESSION, result: "echo: hello", numTurns: 1 });
    expect(turn.result({ terminationReason: null }).error).toBeUndefined();
  });

  it("answers with every finalAnswer, in order, and never with commentary", () => {
    const { turn, feed } = harness();
    feed("item/completed", { item: message("m1", { status: "completed", messagePhase: "commentary", text: "Let me look." }) });
    feed("item/completed", { item: message("m2", { status: "completed", messagePhase: "finalAnswer", text: "Part one." }) });
    feed("item/completed", { item: message("m3", { status: "completed", messagePhase: "finalAnswer", text: "Part two." }) });
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(turn.result({ terminationReason: null }).result).toBe("Part one.\n\nPart two.");
  });

  it("falls back to the last message that said anything when none is a finalAnswer", () => {
    const { turn, feed } = harness();
    feed("item/completed", { item: message("m1", { status: "completed", messagePhase: "commentary", text: "first" }) });
    feed("item/completed", { item: message("m2", { status: "completed", text: "second" }) });
    feed("item/completed", { item: message("m3", { status: "completed", text: "  " }) });
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(turn.result({ terminationReason: null }).result).toBe("second");
  });

  it("streams the part of a completed message that no delta carried, and sets one message apart from the last", () => {
    const { deltas, feed } = harness();
    feed("item/completed", { item: message("m1", { status: "completed", messagePhase: "commentary", text: "Looking." }) });
    feed("item/started", { item: message("m2", { status: "inProgress", text: "" }) });
    feed("item/delta", { itemId: "m2", field: "text", delta: "Done" });
    feed("item/completed", { item: message("m2", { status: "completed", messagePhase: "finalAnswer", text: "Done." }) });
    expect(deltas.map((d) => d.content)).toEqual(["Looking.", "\n\nDone", "."]);
  });

  it("never shows reasoning, however it is announced or streamed", () => {
    const { deltas, turn, feed } = harness();
    feed("item/started", { item: { itemId: "r1", kind: "reasoning", status: "inProgress", summary: [] } });
    feed("item/delta", { itemId: "r1", field: "summary.0", delta: "secret thoughts" });
    feed("item/completed", { item: { itemId: "r1", kind: "reasoning", status: "completed", summary: ["secret thoughts"], text: "secret thoughts" } });
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(deltas).toEqual([]);
    expect(turn.answer()).toBe("");
    expect(turn.result({ terminationReason: null }).error).toMatch(/without an answer/);
  });

  it("ignores another session's notifications (a reminder child's, a subagent's)", () => {
    const { turn, deltas } = harness();
    turn.read("item/delta", { sessionId: "child-session", itemId: "x", field: "text", delta: "not mine" });
    turn.read("turn/completed", { sessionId: "child-session", turnId: TURN, terminal: "failed", error: { kind: "modelError", message: "child failed" } });
    expect(deltas).toEqual([]);
    expect(turn.isCompleted).toBe(false);
  });
});

describe("MuseTurn: settling", () => {
  it("does not settle on turn/foregroundCompleted, only on turn/completed", async () => {
    const { turn, feed } = harness();
    let settled = false;
    void turn.whenCompleted().then(() => { settled = true; });
    feed("turn/foregroundCompleted", { turnId: TURN, blockingAgents: ["goal-reminder"] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(turn.isCompleted).toBe(false);
    expect(settled).toBe(false);
    feed("turn/completed", { turnId: TURN, terminal: "completed" });
    await turn.whenCompleted();
    expect(settled).toBe(true);
  });

  it("does not take another turn's completion for its own", () => {
    const { turn, feed } = harness();
    feed("turn/completed", { turnId: "some-other-turn", terminal: "completed" });
    expect(turn.isCompleted).toBe(false);
  });

  it("settles on turn/unqueued with an error", async () => {
    const { turn, feed } = harness();
    feed("turn/unqueued", { turnId: TURN });
    await turn.whenCompleted();
    expect(turn.result({ terminationReason: null }).error).toMatch(/unqueued/);
  });
});

describe("MuseTurn: tool calls", () => {
  const call = (fields: Record<string, unknown>) => ({ itemId: "t1", kind: "toolCall", turnId: TURN, revision: 1, tool: "bash", callId: "call_9", args: "{\"command\":\"ls -la\"}", ...fields });

  it("streams tool_use at the start and tool_result at the end, with the name, id and input", () => {
    const { deltas, feed } = harness();
    feed("item/started", { item: call({ status: "inProgress" }) });
    feed("item/completed", { item: call({ status: "completed", visibleOutput: "a\nb" }) });
    expect(deltas).toEqual([
      { type: "tool_use", content: "bash: ls -la", toolName: "bash", toolId: "call_9", input: "{\"command\":\"ls -la\"}" },
      { type: "tool_result", content: "a\nb", toolName: "bash", toolId: "call_9" },
    ]);
  });

  it("announces a call once however many times it is updated, and results only at a terminal status", () => {
    const { deltas, feed } = harness();
    feed("item/started", { item: call({ status: "inProgress" }) });
    feed("item/updated", { item: call({ status: "inProgress", revision: 2 }) });
    feed("item/updated", { item: call({ status: "inProgress", revision: 3 }) });
    expect(deltas.filter((d) => d.type === "tool_use")).toHaveLength(1);
    expect(deltas.filter((d) => d.type === "tool_result")).toHaveLength(0);
  });

  it("reports a failed call's reason as its result, and a call first seen completed as both", () => {
    const { deltas, feed } = harness();
    feed("item/completed", { item: call({ status: "failed", failureReason: "exit 2" }) });
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "tool_result"]);
    expect(deltas[1]!.content).toBe("exit 2");
  });

  it("waits to announce a call until its name is known", () => {
    const { deltas, feed } = harness();
    feed("item/started", { item: { itemId: "t2", kind: "toolCall", status: "inProgress" } });
    expect(deltas).toEqual([]);
    feed("item/updated", { item: { itemId: "t2", kind: "toolCall", status: "inProgress", tool: "read", args: "{\"path\":\"a.ts\"}" } });
    expect(deltas).toMatchObject([{ type: "tool_use", toolName: "read", content: "read: a.ts" }]);
  });

  it("shows the output of Muse's shell envelope, with the exit code only when it is not zero", () => {
    const envelope = (fields: Record<string, unknown>) => JSON.stringify({ chunk_id: "exec-1-1", command: "ls", ...fields });
    expect(toolOutputText(envelope({ exit_code: 0, output: "a\nb\n" }))).toBe("a\nb\n");
    expect(toolOutputText(envelope({ exit_code: 2, output: "boom" }))).toBe("boom\n(exit code 2)");
    expect(toolOutputText(envelope({ exit_code: 1, output: "" }))).toBe("(exit code 1)");
    // Anything that is not an envelope is shown as it is.
    expect(toolOutputText("plain text")).toBe("plain text");
    expect(toolOutputText("{\"no\":\"output\"}")).toBe("{\"no\":\"output\"}");
    expect(toolOutputText(undefined, "exit 2")).toBe("exit 2");
    expect(toolOutputText(undefined)).toBe("");
  });

  it("describes a call by what it acts on, or by its name", () => {
    expect(describeMuseToolCall("bash", "{\"command\":\"ls\"}")).toBe("bash: ls");
    expect(describeMuseToolCall("grep", "{\"pattern\":\"TODO\"}")).toBe("grep: TODO");
    expect(describeMuseToolCall("think", "not json")).toBe("Running think");
    expect(describeMuseToolCall(undefined, undefined)).toBe("Running tool");
  });
});

describe("MuseTurn: model retries", () => {
  it("shows a provider retry as a status line and does not fail the turn", () => {
    const { turn, deltas, feed } = harness();
    feed("turn/modelRetryScheduled", { turnId: TURN, attempt: 1, nextAttempt: 2, maxAttempts: 10, retryDelayMs: 1000, errorKind: "rate_limited", httpStatus: 429, system: "meta" });
    expect(deltas).toEqual([{ type: "status", content: "Muse Code rate limited (HTTP 429); retry 2/10 in 1s" }]);
    expect(turn.isCompleted).toBe(false);
  });

  it("words the delay and the missing members sensibly", () => {
    expect(formatRetryDelay(250)).toBe("250ms");
    expect(formatRetryDelay(1500)).toBe("1.5s");
    expect(formatRetryDelay(90_000)).toBe("1m 30s");
    expect(formatRetryDelay(120_000)).toBe("2m");
    expect(describeModelRetry({ attempt: 3 })).toBe("Muse Code error; retry 4");
    expect(describeModelRetry({ errorKind: "server_error", httpStatus: 503, nextAttempt: 2, maxAttempts: 5, retryDelayMs: 2000 })).toBe("Muse Code server error (HTTP 503); retry 2/5 in 2s");
  });
});

describe("MuseTurn: failures", () => {
  const failed = (error: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const h = harness();
    h.feed("turn/completed", { turnId: TURN, terminal: "failed", error, ...extra });
    return h.turn.result({ terminationReason: null });
  };

  it("maps a quota error to a rejected rate limit with the reset in whole seconds", () => {
    const result = failed({ kind: "modelError", message: "API error 429: Usage limit reached (tier_limit_error)", quota: { limitKind: "tierLimit", resetsAtMs: 1792074933999 }, retryable: false });
    expect(result).toMatchObject({
      result: "",
      error: "API error 429: Usage limit reached (tier_limit_error)",
      numTurns: 1,
      rateLimit: { status: "rejected", resetsAt: 1792074933, rateLimitType: "tierLimit" },
    });
  });

  it("branches on the quota detail, not on what the message says", () => {
    const worded = failed({ kind: "modelError", message: "API error 429: Usage limit reached (tier_limit_error)", retryable: false });
    expect(worded.rateLimit).toBeUndefined();
    const hidden = failed({ kind: "modelError", message: "something else entirely", quota: { limitKind: "weekly", resetsAtMs: 5_000 } });
    expect(hidden.rateLimit).toEqual({ status: "rejected", resetsAt: 5, rateLimitType: "weekly" });
  });

  it("tells the operator how to sign in on authRequired, keeping the server's words", () => {
    const result = failed({ kind: "authRequired", message: "No credentials", retryable: false });
    expect(result.error).toMatch(/muse login/);
    expect(result.error).toMatch(/META_API_KEY/);
    expect(result.error).toContain("No credentials");
    expect(result.numTurns).toBe(1);
  });

  it("reports a plain failure's message, and counts it as a turn so the resume id is kept", () => {
    expect(failed({ kind: "launchError", message: "the model stopped" })).toMatchObject({ error: "the model stopped", numTurns: 1 });
  });

  it("does not let narration from before the failure pass for an answer", () => {
    const { turn, feed } = harness();
    feed("item/completed", { item: message("m1", { status: "completed", messagePhase: "finalAnswer", text: "Let me check first.", cutOff: true }) });
    feed("turn/completed", { turnId: TURN, terminal: "failed", error: { kind: "modelError", message: "stream died" } });
    expect(turn.result({ terminationReason: null })).toMatchObject({ result: "", error: "stream died" });
  });

  it("reads a cancelled turn as interrupted, in the words the runner treats as a stop", () => {
    const { turn, feed } = harness();
    feed("turn/completed", { turnId: TURN, terminal: "cancelled" });
    expect(turn.result({ terminationReason: null }).error).toMatch(/^Interrupted/);
  });

  it("a stop from outside wins, with the reason it was given", () => {
    const { turn, feed } = harness();
    feed("turn/completed", { turnId: TURN, terminal: "cancelled" });
    expect(turn.result({ terminationReason: "Interrupted: gateway shutting down" })).toMatchObject({ result: "", error: "Interrupted: gateway shutting down", numTurns: 1 });
  });

  it("names a terminal it does not know rather than calling it an answer", () => {
    const { turn, feed } = harness();
    feed("turn/completed", { turnId: TURN, terminal: "retracted" });
    expect(turn.result({ terminationReason: null }).error).toBe("Muse Code ended the turn as retracted");
  });
});

describe("MuseTurn: accounting", () => {
  it("takes the context size from session/contextUsage, else from the turn's input", () => {
    const a = harness();
    a.feed("session/contextUsage", { usedTokens: 4200, windowTokens: 200000 });
    a.feed("turn/completed", { turnId: TURN, terminal: "completed", usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 5 } });
    expect(a.turn.result({ terminationReason: null }).contextTokens).toBe(4200);

    const b = harness();
    b.feed("turn/completed", { turnId: TURN, terminal: "completed", usage: { inputTokens: 100, cachedTokens: 20, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 7 } });
    expect(b.turn.result({ terminationReason: null }).contextTokens).toBe(127);

    const c = harness();
    c.feed("turn/completed", { turnId: TURN, terminal: "completed" });
    expect(c.turn.result({ terminationReason: null }).contextTokens).toBeUndefined();
  });

  it("reports the duration, and a cost only when the model's rates are known", () => {
    const { turn, feed } = harness();
    feed("turn/completed", { turnId: TURN, terminal: "completed", durationMs: 2049, usage: { inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000 } });
    expect(turn.result({ terminationReason: null }).cost).toBeUndefined();
    const priced = turn.result({ terminationReason: null, costRates: { input: 2, cached: 0.5, output: 10 } });
    expect(priced.durationMs).toBe(2049);
    expect(priced.cost).toBeCloseTo(500_000 * 2 / 1e6 + 500_000 * 0.5 / 1e6 + 100_000 * 10 / 1e6);
    expect(museTurnCost(undefined, { input: 1, cached: 1, output: 1 })).toBeUndefined();
    expect(museTurnCost({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, { input: 1, cached: 1, output: 1 })).toBeUndefined();
  });

  it("keeps the latest subscription usage and tells the listener of each", () => {
    const { turn, usages } = harness();
    const snapshot = (used: number) => ({ observedAtMs: 1, tier: "everyday", window: { usedPercent: used, windowDurationMins: 300, resetsAtMs: 9 }, weekly: { usedPercent: 17, resetsAtMs: 99 } });
    // usage/changed carries no session id: it is the account's.
    turn.read("usage/changed", snapshot(42));
    turn.read("usage/changed", snapshot(43));
    turn.read("usage/changed", { observedAtMs: 1 });
    expect(usages).toHaveLength(2);
    expect(turn.subscriptionUsage).toMatchObject({ tier: "everyday", window: { usedPercent: 43 } });
  });
});

describe("MuseTurn: robustness", () => {
  it("shrugs off items and fields it does not know", () => {
    const { turn, deltas, feed } = harness();
    feed("item/started", { item: { itemId: "w1", kind: "webSearch", status: "inProgress" } });
    feed("item/started", { item: "not an object" });
    feed("item/delta", { itemId: "nope", field: "output", delta: "x" });
    feed("session/somethingNew", { a: 1 });
    expect(deltas).toEqual([]);
    expect(turn.isCompleted).toBe(false);
  });
});
