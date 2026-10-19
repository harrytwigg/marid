import { describe, it, expect } from "vitest";

import { cancelledV2Requests, jinnSessionNotes, withJinnSessionNotes, type JinnSessionNotes } from "../opencode-v2-history.js";
import { ownStoredReplies, parseSseEvent } from "../opencode-v2-turn.js";
import type { V2Message } from "../opencode-v2-events.js";

/**
 * What an OpenCode 2 session's history says about requests cancelled in it, the
 * notes Jinn keeps in the session's metadata, and the event stream's framing.
 */

let seq = 0;
const id = (prefix: string) => `${prefix}_test${String(++seq).padStart(4, "0")}`;
const user = (text: string, metadata?: Record<string, unknown>): V2Message => ({ id: id("msg"), type: "user", text, time: { created: ++seq }, ...(metadata ? { metadata } : {}) });
const assistant = (finish = "stop", over: Record<string, unknown> = {}): V2Message => ({ id: id("msg"), type: "assistant", finish, content: [], time: { created: ++seq, completed: ++seq }, ...over });
const idle = (outcome: string): V2Message => ({ id: id("msg"), type: "idle", outcome, time: { created: ++seq } });

/** A history written oldest first, listed as the server lists it: newest first. */
const newestFirst = (...oldestFirst: V2Message[]): V2Message[] => [...oldestFirst].reverse();

describe("cancelledV2Requests", () => {
  it("finds nothing while the session is running", () => {
    const history = newestFirst(user("older"), assistant(), idle("interrupted"), user("running now"));
    expect(cancelledV2Requests(history, true)).toEqual([]);
  });

  it("finds nothing for an empty history", () => {
    expect(cancelledV2Requests([], false)).toEqual([]);
  });

  it("finds nothing when the newest execution succeeded", () => {
    expect(cancelledV2Requests(newestFirst(user("did it"), assistant(), idle("succeeded")), false)).toEqual([]);
  });

  it("finds nothing when the newest execution failed", () => {
    expect(cancelledV2Requests(newestFirst(user("tried"), assistant("error"), idle("failed")), false)).toEqual([]);
  });

  it("collects the operator's requests of an interrupted execution, oldest first", () => {
    const history = newestFirst(user("first"), user("second"), assistant("error", { error: { type: "aborted" } }), idle("interrupted"));
    expect(cancelledV2Requests(history, false)).toEqual(["first", "second"]);
  });

  it("trims a request and skips one with no text", () => {
    const history = newestFirst(user("  padded  "), user("   "), idle("interrupted"));
    expect(cancelledV2Requests(history, false)).toEqual(["padded"]);
  });

  it("steps over Jinn's own items in an interrupted execution", () => {
    const history = newestFirst(user("operator asked"), user("jinn prompt", { jinn: "prompt" }), assistant("error"), idle("interrupted"));
    expect(cancelledV2Requests(history, false)).toEqual(["operator asked"]);
  });

  it("steps over a synthetic item", () => {
    const history = newestFirst(user("asked"), { id: id("msg"), type: "synthetic", text: "[note]", time: { created: ++seq } }, idle("interrupted"));
    expect(cancelledV2Requests(history, false)).toEqual(["asked"]);
  });

  it("collects across two consecutive interrupted executions", () => {
    const history = newestFirst(
      user("one"), assistant("error"), idle("interrupted"),
      user("two"), assistant("error"), idle("interrupted"),
    );
    expect(cancelledV2Requests(history, false)).toEqual(["one", "two"]);
  });

  it("stops the walk at an execution that succeeded", () => {
    const history = newestFirst(
      user("answered long ago"), assistant(), idle("succeeded"),
      user("cancelled"), assistant("error"), idle("interrupted"),
    );
    expect(cancelledV2Requests(history, false)).toEqual(["cancelled"]);
  });

  it("stops the walk at an execution that failed", () => {
    const history = newestFirst(user("broke"), assistant("error"), idle("failed"), user("cancelled"), idle("interrupted"));
    expect(cancelledV2Requests(history, false)).toEqual(["cancelled"]);
  });

  it("ends the walk at a Jinn prompt that carried a notice", () => {
    const history = newestFirst(
      user("named in the notice"), idle("interrupted"),
      user("jinn prompt with notice", { jinn: "prompt", notice: true }), assistant("error"),
      user("cancelled after it"), idle("interrupted"),
    );
    // The newest execution's requests are collected up to the notice prompt, which ends the walk.
    expect(cancelledV2Requests(history, false)).toEqual(["cancelled after it"]);
  });

  it("ignores items newer than the newest idle (not yet run in an execution)", () => {
    const history = newestFirst(user("cancelled"), idle("interrupted"), user("queued after"), assistant("stop"));
    expect(cancelledV2Requests(history, false)).toEqual(["cancelled"]);
  });
});

describe("Jinn's notes on a session", () => {
  it("reads nothing from metadata that has no jinn key", () => {
    expect(jinnSessionNotes(undefined)).toEqual({ stopped: [], reseed: false });
    expect(jinnSessionNotes({ other: 1 })).toEqual({ stopped: [], reseed: false });
    expect(jinnSessionNotes({ jinn: "prompt" })).toEqual({ stopped: [], reseed: false });
  });

  it("reads stopped prompts (strings only) and the reseed flag", () => {
    expect(jinnSessionNotes({ jinn: { stopped: ["a", 3, "b"], reseed: true } })).toEqual({ stopped: ["a", "b"], reseed: true });
    expect(jinnSessionNotes({ jinn: { reseed: "yes" } }).reseed).toBe(false);
  });

  it("round-trips notes through metadata", () => {
    const notes: JinnSessionNotes = { stopped: ["stop me", "and me"], reseed: true };
    expect(jinnSessionNotes(withJinnSessionNotes(undefined, notes))).toEqual(notes);
    expect(jinnSessionNotes(withJinnSessionNotes({}, { stopped: ["x"], reseed: false }))).toEqual({ stopped: ["x"], reseed: false });
  });

  it("keeps every other metadata key, and replaces the old notes whole", () => {
    const metadata = { title: "keep", jinn: { stopped: ["old"], reseed: true } };
    expect(withJinnSessionNotes(metadata, { stopped: ["new"], reseed: false })).toEqual({ title: "keep", jinn: { stopped: ["new"] } });
  });

  it("removes the jinn key when there are no notes", () => {
    const next = withJinnSessionNotes({ title: "keep", jinn: { stopped: ["old"] } }, { stopped: [], reseed: false });
    expect(next).toEqual({ title: "keep" });
    expect(next).not.toHaveProperty("jinn");
    expect(withJinnSessionNotes(undefined, { stopped: [], reseed: false })).toEqual({});
  });
});

describe("ownStoredReplies", () => {
  it("returns the assistants after the prompt, oldest first, up to the next user item", () => {
    const prompt = user("mine");
    const a1 = assistant("tool-calls");
    const a2 = assistant("stop");
    const history = newestFirst(user("earlier"), assistant(), prompt, a1, a2, idle("succeeded"), user("someone else"), assistant());
    expect(ownStoredReplies(history, new Set([prompt.id as string]))).toEqual([a1, a2]);
  });

  it("stops at a compaction item", () => {
    const prompt = user("mine");
    const a1 = assistant();
    const history = newestFirst(prompt, a1, { id: id("msg"), type: "compaction", status: "completed", time: { created: ++seq } }, assistant());
    expect(ownStoredReplies(history, new Set([prompt.id as string]))).toEqual([a1]);
  });

  it("steps over idle and model-switched items between the prompt and its replies", () => {
    const prompt = user("mine");
    const a1 = assistant("error");
    const a2 = assistant("stop");
    const history = newestFirst(
      prompt,
      { id: id("msg"), type: "model-switched", model: { id: "m2", providerID: "mock" }, time: { created: ++seq } },
      a1,
      idle("failed"),
      a2,
    );
    expect(ownStoredReplies(history, new Set([prompt.id as string]))).toEqual([a1, a2]);
  });

  it("follows a re-sent copy of the prompt as well", () => {
    const prompt = user("mine");
    const copy = user("mine");
    const a1 = assistant("error");
    const a2 = assistant("stop");
    const history = newestFirst(prompt, a1, copy, a2);
    expect(ownStoredReplies(history, new Set([prompt.id as string, copy.id as string]))).toEqual([a1, a2]);
  });

  it("returns nothing when the prompt is not in the history, or has no replies yet", () => {
    const prompt = user("mine");
    expect(ownStoredReplies(newestFirst(user("other"), assistant()), new Set([prompt.id as string]))).toEqual([]);
    expect(ownStoredReplies(newestFirst(prompt), new Set([prompt.id as string]))).toEqual([]);
  });

  it("does not reorder the history it is given", () => {
    const prompt = user("mine");
    const history = newestFirst(prompt, assistant(), assistant());
    const copy = [...history];
    ownStoredReplies(history, new Set([prompt.id as string]));
    expect(history).toEqual(copy);
  });
});

describe("parseSseEvent", () => {
  it("reads the event from a data line", () => {
    expect(parseSseEvent('data: {"type":"session.execution.started","data":{"sessionID":"ses_test"}}'))
      .toEqual({ type: "session.execution.started", data: { sessionID: "ses_test" } });
  });

  it("reads a data line with no space after the colon, and an event with other fields around it", () => {
    expect(parseSseEvent('id: 7\nevent: message\ndata:{"type":"x","data":{}}')).toEqual({ type: "x", data: {} });
  });

  it("joins a payload split over several data lines", () => {
    expect(parseSseEvent('data: {"type":"x",\ndata: "data":{"n":1}}')).toEqual({ type: "x", data: { n: 1 } });
  });

  it("ignores a heartbeat comment", () => {
    expect(parseSseEvent(": heartbeat")).toBeUndefined();
  });

  it("ignores junk: unparseable data, JSON that is not an event, an empty block", () => {
    expect(parseSseEvent("data: {not json")).toBeUndefined();
    expect(parseSseEvent('data: {"no":"type"}')).toBeUndefined();
    expect(parseSseEvent('data: ["array"]')).toBeUndefined();
    expect(parseSseEvent('data: "string"')).toBeUndefined();
    expect(parseSseEvent("")).toBeUndefined();
    expect(parseSseEvent("retry: 1000")).toBeUndefined();
  });
});
