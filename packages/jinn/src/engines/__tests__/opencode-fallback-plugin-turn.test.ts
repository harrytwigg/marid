import { describe, expect, it } from "vitest";

import { FALLBACK_PLUGIN_ENDED_TURN, OpencodeTurn } from "../opencode-turn.js";

/**
 * A `run` turn on a host whose opencode has a model-fallback plugin. At a usage
 * limit the plugin aborts the turn, so the process exits 0 with no answer and no
 * error of its own, and re-sends the prompt on another model, which the gateway
 * does not follow. The turn then ends as a usage limit that names the plugin.
 */

const noEvents = { code: 0, terminationReason: null, stderr: "" };
const text = JSON.stringify({ type: "text", sessionID: "ses_1", part: { id: "p1", type: "text", text: "the answer", time: { start: 1, end: 2 } } });
const failure = JSON.stringify({ type: "error", sessionID: "ses_1", error: { name: "APIError", data: { message: "Bad Request: no such model", statusCode: 400 } } });

describe("a run turn that a fallback plugin ended", () => {
  it("is a usage limit that names the plugin, so the chain takes over", () => {
    const result = new OpencodeTurn("ses_1", () => true).result(noEvents);
    expect(result.result).toBe("");
    expect(result.error).toBe(`opencode exited successfully without a final assistant response. ${FALLBACK_PLUGIN_ENDED_TURN}`);
    expect(result.error).toContain("model-fallback plugin");
    expect(result.rateLimit).toEqual({ status: "rejected" });
  });

  it("is as it was on a host without the plugin: an error with no rate limit", () => {
    const result = new OpencodeTurn("ses_1").result(noEvents);
    expect(result.error).toBe("opencode exited successfully without a final assistant response");
    expect(result.rateLimit).toBeUndefined();
  });

  it("is not the plugin when a step finished: a blank answer from the model is a plain error", () => {
    const step = JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { id: "s1", type: "step-finish", reason: "stop", cost: 0, tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
    const turn = new OpencodeTurn("ses_1", () => true);
    turn.readLine(step, null);
    const result = turn.result(noEvents);
    expect(result.error).toBe("opencode exited successfully without a final assistant response");
    expect(result.rateLimit).toBeUndefined();
    expect(turn.stoppedBetweenSteps).toBe(false);
  });

  it("is the plugin when a tool step finished and the next one never came", () => {
    const step = JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { id: "s1", type: "step-finish", reason: "tool-calls", cost: 0, tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } });
    const tool = JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { id: "t1", type: "tool", tool: "read", callID: "c1", state: { status: "error", input: { filePath: "a.txt" }, error: "aborted" } } });
    const turn = new OpencodeTurn("ses_1", () => true);
    turn.readLine(tool, null);
    turn.readLine(step, null);
    const result = turn.result(noEvents);
    expect(turn.stoppedBetweenSteps).toBe(true);
    expect(result.error).toContain("model-fallback plugin");
    expect(result.rateLimit).toEqual({ status: "rejected" });
    expect(result.numTurns).toBe(1);
  });

  it("keeps a real answer", () => {
    const turn = new OpencodeTurn("ses_1", () => true);
    turn.readLine(text, null);
    expect(turn.result(noEvents)).toMatchObject({ result: "the answer" });
  });

  it("leaves an error that is not a usage limit, and a process that failed, alone", () => {
    const erred = new OpencodeTurn("ses_1", () => true);
    erred.readLine(failure, null);
    expect(erred.result(noEvents).error).not.toContain("model-fallback plugin");
    expect(erred.result(noEvents).rateLimit).toBeUndefined();
    const crashed = new OpencodeTurn("ses_1", () => true).result({ code: 1, terminationReason: null, stderr: "boom" });
    expect(crashed.error).toBe("opencode exited with code 1: boom");
    expect(new OpencodeTurn("ses_1", () => true).result({ ...noEvents, failure: "stream lost" }).error).toBe("stream lost");
  });

  it("is a stop when the turn was stopped", () => {
    expect(new OpencodeTurn("ses_1", () => true).result({ ...noEvents, terminationReason: "Interrupted" }).error).toBe("Interrupted");
  });
});
