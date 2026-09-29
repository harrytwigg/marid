import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  agentFromCliFlags,
  cancelledRequests as cancelledAndStopped,
  cancelledRequestsNotice,
  stoppedRequestsNotice,
  drainSseEvents,
  JINN_PROMPT_METADATA,
  newMessageId,
  promptModel,
  replyIsDone,
  runLineForEvent,
  runLinesFromMessages,
} from "../opencode-server-turn.js";

/**
 * The translation at the heart of server mode: a server event in, the line
 * `opencode run --format json` would have printed out.
 *
 * Both halves of the fixture are REAL opencode 1.18.31 output captured on
 * build-host (local paths replaced): `runLines` is what `opencode run --attach
 * --format json` printed for a turn that ran a bash tool and answered, in a git
 * repository where that client works; `sseEvents` is part of the `/event`
 * stream for a turn in a directory where it does not. Because a `run` line is
 * `{type, sessionID, part}` around the very Part the server sends in
 * `message.part.updated`, feeding each line's part back through the translator
 * must reproduce the line's type, sessionID and part exactly. (`run` also adds
 * a `timestamp` to each line; the fixture drops it, and `OpencodeTurn` never
 * reads it.)
 */

const fixture = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-1.18.31-events.json"),
  "utf8",
)) as {
  runLines: Array<{ type: string; sessionID: string; part: Record<string, unknown> }>;
  sseEvents: Array<{ type: string; properties: Record<string, unknown> }>;
};

describe("runLineForEvent", () => {
  it("rebuilds every line the real `run --format json` printed (minus its timestamp), from the server's own parts", () => {
    for (const line of fixture.runLines) {
      const event = { type: "message.part.updated", properties: { sessionID: line.sessionID, part: line.part, time: 1 } };
      const rebuilt = runLineForEvent(event, line.sessionID);
      expect(rebuilt, line.type).toBeDefined();
      expect(JSON.parse(rebuilt!)).toEqual({ type: line.type, sessionID: line.sessionID, part: line.part });
    }
  });

  it("from a real non-git turn's stream: step-start, the completed text once, step-finish; nothing else", () => {
    const sessionId = String(fixture.sseEvents.find((e) => e.properties.sessionID)!.properties.sessionID);
    const lines = fixture.sseEvents
      .map((e) => runLineForEvent(e, sessionId))
      .filter((l): l is string => Boolean(l))
      .map((l) => JSON.parse(l) as { type: string; part: { text?: string } });
    expect(lines.map((l) => l.type)).toEqual(["step_start", "text", "step_finish"]);
    expect(lines[1]!.part.text).toBe("SSE1");
  });

  it("ignores another session's parts, streaming (unfinished) text, reasoning and a running tool", () => {
    const part = (fields: Record<string, unknown>) => ({ type: "message.part.updated", properties: { sessionID: "ses_a", part: { sessionID: "ses_a", ...fields } } });
    expect(runLineForEvent(part({ type: "text", text: "hi", time: { end: 2 } }), "ses_b")).toBeUndefined();
    expect(runLineForEvent(part({ type: "text", text: "hi", time: { start: 1 } }), "ses_a")).toBeUndefined();
    expect(runLineForEvent(part({ type: "reasoning", text: "hmm", time: { end: 2 } }), "ses_a")).toBeUndefined();
    expect(runLineForEvent(part({ type: "tool", state: { status: "running" } }), "ses_a")).toBeUndefined();
    expect(runLineForEvent(part({ type: "tool", state: { status: "error", error: "x" } }), "ses_a")).toContain('"tool_use"');
  });

  it("turns this session's session.error into run's error line", () => {
    const error = { name: "APIError", data: { message: "boom" } };
    expect(JSON.parse(runLineForEvent({ type: "session.error", properties: { sessionID: "ses_a", error } }, "ses_a")!))
      .toEqual({ type: "error", sessionID: "ses_a", error });
    expect(runLineForEvent({ type: "session.error", properties: { sessionID: "ses_b", error } }, "ses_a")).toBeUndefined();
  });
});

describe("runLinesFromMessages (recovery from the server's store)", () => {
  it("rebuilds the real turn from its own stored replies, skipping the user's and anyone else's", () => {
    const sessionId = fixture.runLines[0]!.sessionID;
    const messages = [
      { info: { role: "user", id: "msg_mine" }, parts: [{ type: "text", sessionID: sessionId, text: "prompt", time: { end: 1 } }] },
      { info: { role: "assistant", parentID: "msg_mine" }, parts: fixture.runLines.map((l) => l.part) },
      { info: { role: "user", id: "msg_operator" }, parts: [] },
      { info: { role: "assistant", parentID: "msg_operator" }, parts: [{ type: "text", sessionID: sessionId, text: "OPERATOR", time: { end: 2 } }] },
    ];
    const lines = runLinesFromMessages(messages, sessionId, "msg_mine").map((l) => JSON.parse(l) as { type: string });
    expect(lines).toEqual(fixture.runLines.map((l) => ({ type: l.type, sessionID: l.sessionID, part: l.part })));
  });

  it("carries a stored reply's error as run's error line", () => {
    const error = { name: "APIError", data: { message: "down" } };
    const lines = runLinesFromMessages([{ info: { role: "assistant", parentID: "msg_mine", error }, parts: [] }], "ses_a", "msg_mine");
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ type: "error", sessionID: "ses_a", error }]);
  });
});

describe("replyIsDone (opencode's own loop-exit condition)", () => {
  it("is a completed reply with a finish that is not a tool round trip", () => {
    expect(replyIsDone({ time: { created: 1, completed: 2 }, finish: "stop" })).toBe(true);
    expect(replyIsDone({ time: { created: 1, completed: 2 }, finish: "length" })).toBe(true);
    expect(replyIsDone({ time: { created: 1, completed: 2 }, finish: "tool-calls" })).toBe(false);
    expect(replyIsDone({ time: { created: 1, completed: 2 }, finish: "unknown" })).toBe(false);
    expect(replyIsDone({ time: { created: 1 }, finish: "stop" })).toBe(false);
    // An aborted or failed reply has no finish: the session going idle ends it.
    expect(replyIsDone({ time: { created: 1, completed: 2 }, error: { name: "MessageAbortedError" } })).toBe(false);
  });

  it("matches the real 1.18.31 turn: the tool step does not end it, the answer step does", () => {
    const reasons = fixture.runLines.filter((l) => l.type === "step_finish").map((l) => String(l.part.reason));
    expect(reasons).toEqual(["tool-calls", "stop"]);
    expect(reasons.map((finish) => replyIsDone({ time: { completed: 1 }, finish }))).toEqual([false, true]);
  });
});

describe("newMessageId", () => {
  it("has opencode's shape, and ascends with time", () => {
    const a = newMessageId(1790249768459);
    const b = newMessageId(1790249768460);
    expect(a).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(b > a).toBe(true);
    // The stamp is (ms * 0x1000 + counter) mod 2^48 — opencode's own scheme
    // (msg_0d3338b47001… was minted at 1790249768xxx ms).
    expect(a.slice(4, 8)).toBe("0d33");
  });
});

describe("drainSseEvents", () => {
  it("returns complete events and keeps a split one for the next read", () => {
    const a = `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`;
    const b = `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_a" } })}\n\n`;
    const first = drainSseEvents(a + b.slice(0, 20));
    expect(first.events.map((e) => e.type)).toEqual(["server.connected"]);
    const second = drainSseEvents(first.rest + b.slice(20));
    expect(second.events.map((e) => e.type)).toEqual(["session.idle"]);
    expect(second.rest).toBe("");
  });

  it("skips comments, keep-alives and an unparseable event without losing the rest", () => {
    const out = drainSseEvents(`: ping\n\ndata: {nope\n\ndata: ${JSON.stringify({ type: "x", properties: {} })}\n\n`);
    expect(out.events.map((e) => e.type)).toEqual(["x"]);
  });
});

describe("prompt shaping", () => {
  it("splits provider/model at the first slash only", () => {
    expect(promptModel("opencode-go/deepseek-v4.1-flash")).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" });
    expect(promptModel("openrouter/meta-llama/llama-4")).toEqual({ providerID: "openrouter", modelID: "meta-llama/llama-4" });
    expect(promptModel("bare")).toBeUndefined();
    expect(promptModel(undefined)).toBeUndefined();
  });

  it("takes --agent from cliFlags", () => {
    expect(agentFromCliFlags(["--agent", "build"])).toBe("build");
    expect(agentFromCliFlags(["--other"])).toBeUndefined();
  });
});

describe("cancelledRequests (what the model is told the user cancelled)", () => {
  // The operator's cancelled requests; the Jinn prompts the user stopped are below.
  const cancelledRequests = (...args: Parameters<typeof cancelledAndStopped>) => cancelledAndStopped(...args).cancelled;
  // Shapes as opencode 1.18.32 stores them: a user message and its replies, a
  // reply's error, and the metadata / synthetic flag on the parts Jinn posts.
  // Times default to the id's number in seconds, so the history's order is also its timeline.
  const at = (id: string) => Number(id.slice(4)) * 1000;
  const operator = (id: string, text: string, created = at(id)) => ({ info: { id, role: "user", time: { created } }, parts: [{ type: "text", text }] });
  const jinn = (id: string, text: string) => ({ info: { id, role: "user", time: { created: at(id) } }, parts: [{ type: "text", text, metadata: JINN_PROMPT_METADATA }] });
  const reply = (id: string, parentID: string, how: "done" | "aborted" | "failed" | "running" | "tool-calls", completed = at(id)) => ({
    info: {
      id,
      role: "assistant",
      parentID,
      time: how === "running" ? { created: at(id) } : { created: at(id), completed },
      ...(how === "done" ? { finish: "stop" } : how === "tool-calls" ? { finish: "tool-calls" } : {}),
      ...(how === "aborted" ? { error: { name: "MessageAbortedError", data: { message: "aborted" } } } : {}),
      ...(how === "failed" ? { error: { name: "APIError", data: { message: "upstream" } } } : {}),
    },
    parts: [],
  });

  it("names the operator's request whose reply was aborted, as the real history had it", () => {
    expect(cancelledRequests([
      jinn("msg_01", "Reply with exactly: SMOKE_ONE_OK"), reply("msg_02", "msg_01", "done"),
      operator("msg_03", "Use your read tool to read /etc/hostname and reply with its contents."), reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual(["Use your read tool to read /etc/hostname and reply with its contents."]);
  });

  it("goes by a request's NEWEST reply: aborted after a tool round, it was cancelled; answered after an abort, it was not", () => {
    expect(cancelledRequests([operator("msg_01", "a"), reply("msg_02", "msg_01", "tool-calls"), reply("msg_03", "msg_01", "aborted")], false)).toEqual(["a"]);
    expect(cancelledRequests([operator("msg_01", "a"), reply("msg_02", "msg_01", "aborted"), reply("msg_03", "msg_01", "done")], false)).toEqual([]);
  });

  it("collects every cancelled request back to the last one that was not, oldest first", () => {
    expect(cancelledRequests([
      operator("msg_01", "old, cancelled, then answered past"), reply("msg_02", "msg_01", "aborted"),
      jinn("msg_03", "answered"), reply("msg_04", "msg_03", "done"),
      operator("msg_05", "first"), reply("msg_06", "msg_05", "aborted"),
      operator("msg_07", "second"), reply("msg_08", "msg_07", "aborted"),
    ], false)).toEqual(["first", "second"]);
  });

  it("steps over Jinn's own prompts that were aborted or dropped, and never calls one of them cancelled", () => {
    // A Jinn prompt queued behind the operator's is dropped (no reply) by the
    // operator's abort; one Jinn stopped itself (a restart, a timeout) is not the user's cancel.
    expect(cancelledRequests([
      operator("msg_01", "rm -rf build"), reply("msg_02", "msg_01", "aborted"),
      jinn("msg_03", "queued jinn work"),
      jinn("msg_04", "interrupted jinn work"), reply("msg_05", "msg_04", "aborted"),
    ], false)).toEqual(["rm -rf build"]);
    expect(cancelledRequests([jinn("msg_01", "interrupted jinn work"), reply("msg_02", "msg_01", "aborted")], false)).toEqual([]);
  });

  it("is empty when the history ends in anything but a cancel: answered, failed otherwise, running, or waiting to run", () => {
    const aborted = [operator("msg_01", "cancelled"), reply("msg_02", "msg_01", "aborted")];
    expect(cancelledRequests([...aborted, operator("msg_03", "answered"), reply("msg_04", "msg_03", "done")], false)).toEqual([]);
    expect(cancelledRequests([...aborted, operator("msg_03", "failed"), reply("msg_04", "msg_03", "failed")], false)).toEqual([]);
    expect(cancelledRequests([...aborted, operator("msg_03", "running"), reply("msg_04", "msg_03", "running")], true)).toEqual([]);
    // No reply yet, and the session busy: queued, not cancelled.
    expect(cancelledRequests([...aborted, operator("msg_03", "waiting to run")], true)).toEqual([]);
    expect(cancelledRequests([...aborted, jinn("msg_03", "answered"), reply("msg_04", "msg_03", "done")], false)).toEqual([]);
    expect(cancelledRequests([], false)).toEqual([]);
  });

  it("with the session idle, an operator request with no reply was dropped by the abort, and was cancelled with it", () => {
    // QA, real 1.18.32: a follow-up typed while the first request
    // waits on its permission is queued; Esc aborts the first and drops it.
    // As stored on 1.18.32: the follow-up is created while the first request's
    // reply runs, and that reply is completed (aborted) after it.
    const history = [
      jinn("msg_01", "answered"), reply("msg_02", "msg_01", "done"),
      operator("msg_03", "read /etc/hostname"), reply("msg_04", "msg_03", "aborted", 6000),
      operator("msg_05", "also read /etc/os-release"),
    ];
    expect(cancelledRequests(history, false)).toEqual(["read /etc/hostname", "also read /etc/os-release"]);
    // The same history while the session is busy: the follow-up still waits to run.
    expect(cancelledRequests(history, true)).toEqual([]);
  });

  it("a request with no reply created after the abort ended was not dropped by it: not yet picked up, or failed before replying", () => {
    // QA round 2 on opencode takes up to ~700 ms to pick a prompt up,
    // so the session can read idle while a fresh operator prompt has no reply.
    const history = [
      operator("msg_03", "read /etc/hostname"), reply("msg_04", "msg_03", "aborted", 4500),
      operator("msg_05", "a new request, just typed"),
    ];
    expect(cancelledRequests(history, false)).toEqual([]);
  });

  it("quotes what the operator typed, not a synthetic part opencode added, and skips a request with no text", () => {
    expect(cancelledRequests([
      { info: { id: "msg_01", role: "user" }, parts: [{ type: "file", url: "file:///x" }] }, reply("msg_02", "msg_01", "aborted"),
      { info: { id: "msg_03", role: "user" }, parts: [{ type: "text", text: "Called the Read tool", synthetic: true }, { type: "text", text: "typed" }] },
      reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual(["typed"]);
  });

  it("tells the model plainly, quoting each request (long ones cut)", () => {
    const notice = cancelledRequestsNotice(["read /etc/hostname", `two\nlines ${"x".repeat(600)}`]);
    expect(notice).toContain("the user cancelled");
    expect(notice).toContain("Do not carry them out");
    expect(notice).toContain("> read /etc/hostname");
    expect(notice).toContain("> two\n> lines ");
    expect(notice).toContain("x…");
    expect(notice).not.toContain("x".repeat(600));
  });

  // a Jinn prompt the user stopped, as its turn marks it (metadata PATCHed on 1.18.32).
  const stopped = (id: string, text: string, request?: string) => ({
    info: { id, role: "user", time: { created: at(id) } },
    parts: [{ type: "text", text, metadata: { ...JINN_PROMPT_METADATA, stopped: "user", ...(request === undefined ? {} : { request }) } }],
  });

  it("names a Jinn prompt the user stopped, aborted or dropped, apart from the operator's cancels", () => {
    expect(cancelledAndStopped([
      jinn("msg_01", "answered"), reply("msg_02", "msg_01", "done"),
      stopped("msg_03", "run sleep 45"), reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual({ cancelled: [], stopped: ["run sleep 45"] });
    // Queued behind another prompt when the stop's abort dropped it: no reply at all.
    expect(cancelledAndStopped([stopped("msg_01", "queued, then stopped")], false)).toEqual({ cancelled: [], stopped: ["queued, then stopped"] });
    // Both kinds in one history, each list oldest first; an unmarked Jinn stop between them is stepped over.
    expect(cancelledAndStopped([
      stopped("msg_01", "first stop"), reply("msg_02", "msg_01", "aborted"),
      operator("msg_03", "read /etc/hostname"), reply("msg_04", "msg_03", "aborted"),
      jinn("msg_05", "a restart stopped this"), reply("msg_06", "msg_05", "aborted"),
      stopped("msg_07", "second stop"), reply("msg_08", "msg_07", "tool-calls"), reply("msg_09", "msg_07", "aborted"),
    ], false)).toEqual({ cancelled: ["read /etc/hostname"], stopped: ["first stop", "second stop"] });
  });

  it("a stopped prompt whose reply had already finished was not cut short, and ends the walk", () => {
    // Stop raced the reply's end: the mark lands on an answered prompt.
    expect(cancelledAndStopped([
      stopped("msg_01", "older stop"), reply("msg_02", "msg_01", "aborted"),
      stopped("msg_03", "answered anyway"), reply("msg_04", "msg_03", "done"),
    ], false)).toEqual({ cancelled: [], stopped: [] });
  });

  it("quotes the request the turn recorded, not a first turn's system prompt", () => {
    expect(cancelledAndStopped([
      stopped("msg_01", "You are Senior Developer…\n\n---\n\ndeploy the site", "deploy the site"), reply("msg_02", "msg_01", "aborted"),
    ], false).stopped).toEqual(["deploy the site"]);
  });

  it("a recorded request is the quote even when empty: never the stored text, which may be the system prompt", () => {
    expect(cancelledAndStopped([
      stopped("msg_01", "You are Senior Developer…\n\n---\n\n\n\nAttached files:\n- /tmp/a.png", ""), reply("msg_02", "msg_01", "aborted"),
    ], false).stopped).toEqual(["(a request with no text)"]);
  });

  // A Jinn prompt as posted with a notice ahead of it (a synthetic part of either kind).
  const noticed = (id: string, text: string, kind: "cancelled-requests" | "stopped-requests", mark?: "stopped") => ({
    info: { id, role: "user", time: { created: at(id) } },
    parts: [
      { type: "text", text: "[Jinn] Before this message, …", synthetic: true, metadata: { jinn: kind } },
      { type: "text", text, metadata: { ...JINN_PROMPT_METADATA, ...(mark ? { stopped: "user", request: text } : {}) } },
    ],
  });

  it("a request is named once; a Jinn prompt that carried a notice ends the walk, cut short or not", () => {
    // Stop A; B carried the notice naming A, then a restart (or a new message) cut B short, unmarked.
    expect(cancelledAndStopped([
      stopped("msg_01", "A"), reply("msg_02", "msg_01", "aborted"),
      noticed("msg_03", "B: continue A", "stopped-requests"), reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual({ cancelled: [], stopped: [] });
    // The same for an operator's cancel named on a Jinn prompt a restart then cut short.
    expect(cancelledAndStopped([
      operator("msg_01", "read /etc/hostname"), reply("msg_02", "msg_01", "aborted"),
      noticed("msg_03", "jinn work", "cancelled-requests"), reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual({ cancelled: [], stopped: [] });
    // B stopped by the user itself: B is named, A (named in B's notice) is not again.
    expect(cancelledAndStopped([
      stopped("msg_01", "A"), reply("msg_02", "msg_01", "aborted"),
      noticed("msg_03", "B", "stopped-requests", "stopped"), reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual({ cancelled: [], stopped: ["B"] });
    // Anything newer than the noticed prompt is still collected.
    expect(cancelledAndStopped([
      noticed("msg_01", "B", "stopped-requests"), reply("msg_02", "msg_01", "aborted"),
      stopped("msg_03", "C"), reply("msg_04", "msg_03", "aborted"),
    ], false)).toEqual({ cancelled: [], stopped: ["C"] });
  });

  it("past a noticed prompt, a request cancelled after that prompt was made is still named", () => {
    // R1 cancelled earlier; J1 reads the history (naming R1); the operator types R2;
    // J1 posts, queued behind R2; Esc aborts R2 and drops J1 (no reply).
    const history = [
      operator("msg_01", "R1"), reply("msg_02", "msg_01", "aborted"),
      operator("msg_03", "R2"),
      noticed("msg_04", "J1", "cancelled-requests"),
      reply("msg_05", "msg_03", "aborted"),
    ];
    expect(cancelledAndStopped(history, false)).toEqual({ cancelled: ["R2"], stopped: [] });
  });

  it("a dropped request is timed by the abort that dropped it, not by a later one", () => {
    // The Stop dropped A, queued behind the operator's R (its abort aborted R too). B carried
    // both notices; a restart then aborted B's reply. The resume must not name A (or R) again.
    const both = {
      info: { id: "msg_05", role: "user", time: { created: at("msg_05") } },
      parts: [
        { type: "text", text: "[Jinn] … R", synthetic: true, metadata: { jinn: "cancelled-requests" } },
        { type: "text", text: "[Jinn] … A", synthetic: true, metadata: { jinn: "stopped-requests" } },
        { type: "text", text: "B", metadata: JINN_PROMPT_METADATA },
      ],
    };
    expect(cancelledAndStopped([
      operator("msg_01", "R"), stopped("msg_02", "A"), reply("msg_03", "msg_01", "aborted", at("msg_04")),
      both, reply("msg_06", "msg_05", "aborted", at("msg_07")),
    ], false)).toEqual({ cancelled: [], stopped: [] });
  });

  it("both notices point at the final message, so neither one's closing line lands on the other", () => {
    for (const notice of [cancelledRequestsNotice(["a"]), stoppedRequestsNotice(["b"])]) {
      expect(notice).toContain("the final message, after these notes");
      expect(notice).not.toContain("the message below");
    }
  });

  it("tells the model the user stopped them, and lets a request to continue through", () => {
    const notice = stoppedRequestsNotice(["run sleep 45", "y".repeat(600)]);
    expect(notice).toContain("the user stopped the request(s) below");
    expect(notice).toContain("Do not carry them out or pick them back up on your own");
    expect(notice).toContain("asking you to continue");
    expect(notice).toContain("> run sleep 45");
    expect(notice).toContain("y…");
    expect(notice).not.toContain("y".repeat(600));
  });
});
