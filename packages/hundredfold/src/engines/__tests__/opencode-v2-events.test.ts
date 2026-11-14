import { describe, it, expect } from "vitest";

import { OpencodeTurn } from "../opencode-turn.js";
import { runLinesFromStoredReply, v2ErrorLine, v2ReplyIsDone, V2RunLines, type V2Event, type V2Message } from "../opencode-v2-events.js";
import type { StreamDelta } from "../../shared/types.js";

/**
 * OpenCode 2's events and stored replies as the lines `OpencodeTurn` reads.
 * Event shapes are those of a real 2.0.29 server's stream and message store
 * (ids and paths made neutral).
 */

const SES = "ses_test0001";
const MSG = "msg_test0001";
const CALL = "call_test0001";
const TOKENS = { input: 1200, output: 30, reasoning: 0, cache: { read: 300, write: 100 } };

function ev(type: string, data: Record<string, unknown>, created = 1_700_000_000_000): V2Event {
  return { type, created, data: { sessionID: SES, assistantMessageID: MSG, ...data } };
}

function parsed(line: string | undefined): any {
  expect(line).toBeDefined();
  return JSON.parse(line!);
}

describe("V2RunLines.lineFor", () => {
  it("reports a tool once, with its name, call id, input and output, when it succeeds", () => {
    const lines = new V2RunLines(SES);
    expect(lines.lineFor(ev("session.tool.input.started", { id: CALL, name: "shell" }))).toBeUndefined();
    expect(lines.lineFor(ev("session.tool.called", { id: CALL, input: { command: "echo hi" }, executed: false }))).toBeUndefined();
    const line = parsed(lines.lineFor(ev("session.tool.success", {
      id: CALL,
      content: [{ type: "text", text: "hi\n" }, { type: "image", data: "x" }, { type: "text", text: "second" }],
      metadata: { exit: 0 },
    })));
    expect(line).toEqual({
      type: "tool_use",
      sessionID: SES,
      part: {
        id: CALL,
        callID: CALL,
        messageID: MSG,
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: { command: "echo hi" }, output: "hi\n\nsecond" },
      },
    });
  });

  it("reports a failed tool as an error with the error message as its output", () => {
    const lines = new V2RunLines(SES);
    lines.lineFor(ev("session.tool.input.started", { id: CALL, name: "bash" }));
    lines.lineFor(ev("session.tool.called", { id: CALL, input: { command: "x" } }));
    const line = parsed(lines.lineFor(ev("session.tool.failed", { id: CALL, error: { type: "tool.execution", message: 'No tool named "bash"' } })));
    expect(line.part.state).toEqual({ status: "error", input: { command: "x" }, output: 'No tool named "bash"' });
    expect(line.part.tool).toBe("bash");
  });

  it("gives a failed tool without a message a plain output, and a tool never announced no name", () => {
    const lines = new V2RunLines(SES);
    const line = parsed(lines.lineFor(ev("session.tool.failed", { id: CALL })));
    expect(line.part.state).toEqual({ status: "error", input: {}, output: "the tool failed" });
    expect(line.part).not.toHaveProperty("tool");
  });

  it("says nothing for a tool result without a call id, or for events it does not read", () => {
    const lines = new V2RunLines(SES);
    expect(lines.lineFor(ev("session.tool.success", { content: [] }))).toBeUndefined();
    expect(lines.lineFor(ev("session.step.started", {}))).toBeUndefined();
    expect(lines.lineFor(ev("session.usage.updated", {}))).toBeUndefined();
    expect(lines.lineFor({ type: "session.step.streamed" })).toBeUndefined();
  });

  it("turns text.ended into a text line, and an empty text into nothing", () => {
    const lines = new V2RunLines(SES);
    const line = parsed(lines.lineFor(ev("session.text.ended", { ordinal: 2, text: "the answer" }, 1234)));
    expect(line).toEqual({
      type: "text",
      sessionID: SES,
      part: { id: `${MSG}#2`, messageID: MSG, type: "text", text: "the answer", time: { end: 1234 } },
    });
    expect(lines.lineFor(ev("session.text.ended", { ordinal: 0, text: "" }))).toBeUndefined();
    expect(lines.lineFor(ev("session.text.started", { ordinal: 0 }))).toBeUndefined();
  });

  it("turns step.ended into a step_finish with its cost, tokens and finish reason", () => {
    const line = parsed(new V2RunLines(SES).lineFor(ev("session.step.ended", { finish: "stop", rawFinish: "stop", cost: 0.25, tokens: TOKENS })));
    expect(line).toEqual({ type: "step_finish", sessionID: SES, part: { type: "step-finish", cost: 0.25, tokens: TOKENS, reason: "stop" } });
  });

  it("turns step.failed and execution.failed into errors named after the v2 error type, with the HTTP status", () => {
    const error = { type: "provider.invalid-request", message: "bad body", status: 400, response: { body: "{}" } };
    for (const type of ["session.step.failed", "session.execution.failed"]) {
      const line = parsed(new V2RunLines(SES).lineFor(ev(type, { error })));
      expect(line).toEqual({ type: "error", sessionID: SES, error: { name: "provider.invalid-request", data: { message: "bad body (HTTP 400)" } } });
    }
  });

  it("leaves the status off an error that has none, and names an error without a type or message", () => {
    expect(parsed(new V2RunLines(SES).lineFor(ev("session.step.failed", { error: { type: "tool.execution", message: "boom" } }))).error.data.message).toBe("boom");
    expect(JSON.parse(v2ErrorLine(SES, {})).error).toEqual({ name: "error", data: { message: "no message" } });
  });

  it("says nothing for an aborted error (the turn's own interrupt), or a failure with no error", () => {
    const lines = new V2RunLines(SES);
    expect(lines.lineFor(ev("session.step.failed", { error: { type: "aborted", message: "Step interrupted" } }))).toBeUndefined();
    expect(lines.lineFor(ev("session.execution.failed", { error: { type: "aborted", message: "x" } }))).toBeUndefined();
    expect(lines.lineFor(ev("session.step.failed", {}))).toBeUndefined();
  });
});

describe("the lines fed to OpencodeTurn", () => {
  function feed(events: V2Event[]): { turn: OpencodeTurn; deltas: StreamDelta[] } {
    const turn = new OpencodeTurn("");
    const deltas: StreamDelta[] = [];
    const lines = new V2RunLines(SES);
    for (const event of events) {
      const line = lines.lineFor(event);
      if (line) turn.readLine(line, (d) => deltas.push(d));
    }
    return { turn, deltas };
  }

  const toolStep: V2Event[] = [
    ev("session.tool.input.started", { id: CALL, name: "shell" }),
    ev("session.tool.called", { id: CALL, input: { command: "echo hi" } }),
    ev("session.tool.success", { id: CALL, content: [{ type: "text", text: "hi\n" }] }),
    ev("session.step.ended", { finish: "tool-calls", cost: 0.5, tokens: TOKENS }),
  ];
  const answerStep: V2Event[] = [
    ev("session.text.ended", { assistantMessageID: "msg_test0002", ordinal: 0, text: "tool done" }),
    ev("session.step.ended", { assistantMessageID: "msg_test0002", finish: "stop", cost: 0.25, tokens: { input: 2000, output: 10, cache: { read: 0, write: 0 } } }),
  ];

  it("answers with the last text, counting steps, adding up cost, and reading the newest step's context", () => {
    const { turn, deltas } = feed([...toolStep, ...answerStep]);
    expect(turn.result({ code: 0, terminationReason: null, stderr: "" })).toEqual({
      sessionId: SES,
      result: "tool done",
      numTurns: 2,
      cost: 0.75,
      contextTokens: 2000,
    });
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "tool_result", "text"]);
    expect(deltas[0]).toMatchObject({ toolName: "shell", toolId: CALL, content: "shell: echo hi" });
    expect(deltas[1]).toMatchObject({ content: "hi\n", toolName: "shell" });
  });

  it("reads context as input plus cache read and write", () => {
    const { turn } = feed(toolStep.slice(3));
    expect(turn.result({ code: 0, terminationReason: null, stderr: "", noAnswer: "no answer" }).contextTokens).toBe(1600);
  });

  it("reports a provider.rate-limit failure as a rejected rate limit", () => {
    const { turn } = feed([
      ev("session.step.failed", { error: { type: "provider.rate-limit", message: "mock 429", status: 429 } }),
      ev("session.execution.failed", { error: { type: "provider.rate-limit", message: "mock 429", status: 429 } }),
    ]);
    const result = turn.result({ code: 0, terminationReason: null, stderr: "" });
    expect(result.error).toBe("provider.rate-limit: mock 429 (HTTP 429)");
    expect(result.rateLimit).toEqual({ status: "rejected" });
    expect(result.result).toBe("");
  });

  it("reports another provider error as a plain failure naming the v2 error type", () => {
    const { turn } = feed([ev("session.execution.failed", { error: { type: "provider.invalid-request", message: "bad", status: 400 } })]);
    const result = turn.result({ code: 0, terminationReason: null, stderr: "" });
    expect(result.error).toBe("provider.invalid-request: bad (HTTP 400)");
    expect(result.rateLimit).toBeUndefined();
  });

  it("does not let an interrupt's aborted step become an error", () => {
    const { turn } = feed([ev("session.step.failed", { error: { type: "aborted", message: "Step interrupted" } })]);
    expect(turn.result({ code: 0, terminationReason: null, stderr: "", noAnswer: "ended with no reply" }).error).toBe("ended with no reply");
  });
});

// Items as GET /api/session/:id/message lists them.
const STORED_TEXT: V2Message = {
  id: "msg_test_text",
  time: { created: 1_700_000_000_000, streamed: 1_700_000_000_020, completed: 1_700_000_000_030 },
  type: "assistant",
  agent: "build",
  model: { id: "m1", providerID: "mock", variant: "default" },
  content: [{ type: "text", text: "hello from mock" }],
  finish: "stop",
  rawFinish: "stop",
  cost: 0.125,
  tokens: { input: 1200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
};
const STORED_TOOL: V2Message = {
  id: "msg_test_tool",
  time: { created: 1_700_000_000_000, streamed: 1_700_000_000_020, completed: 1_700_000_000_030 },
  type: "assistant",
  agent: "build",
  model: { id: "m1", providerID: "mock", variant: "default" },
  content: [{
    type: "tool",
    id: "call_test_tool",
    name: "shell",
    executed: false,
    state: {
      status: "completed",
      input: { command: "echo hi-from-tool", description: "echo" },
      content: [{ type: "text", text: "hi-from-tool\n" }],
      metadata: { status: "completed", exit: 0 },
    },
  }],
  finish: "tool-calls",
  rawFinish: "tool_calls",
  cost: 0,
  tokens: { input: 1200, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
};
const STORED_TOOL_ERROR: V2Message = {
  ...STORED_TOOL,
  id: "msg_test_toolerr",
  content: [{
    type: "tool",
    id: "call_test_err",
    name: "bash",
    executed: false,
    state: {
      status: "error",
      input: { command: "echo hi" },
      error: { type: "tool.execution", message: 'No tool named "bash" is currently available.' },
    },
  }],
};
const STORED_ERROR: V2Message = {
  id: "msg_test_error",
  time: { created: 1_700_000_000_000, streamed: 1_700_000_000_020, completed: 1_700_000_000_030 },
  type: "assistant",
  content: [],
  finish: "error",
  error: { type: "provider.rate-limit", message: "mock 429", status: 429 },
};
const STORED_ABORTED: V2Message = {
  id: "msg_test_aborted",
  time: { created: 1_700_000_000_000, completed: 1_700_000_000_030 },
  type: "assistant",
  content: [{ type: "text", text: "w0 w1 " }],
  finish: "error",
  error: { type: "aborted", message: "Step interrupted" },
};

describe("runLinesFromStoredReply", () => {
  it("replays a stored text reply as its text and its step finish", () => {
    const lines = runLinesFromStoredReply(SES, STORED_TEXT).map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { type: "text", sessionID: SES, part: { id: "msg_test_text#0", messageID: "msg_test_text", type: "text", text: "hello from mock", time: { end: 1_700_000_000_030 } } },
      { type: "step_finish", sessionID: SES, part: { type: "step-finish", cost: 0.125, tokens: STORED_TEXT.tokens, reason: "stop" } },
    ]);
  });

  it("replays a stored completed tool as a tool_use with its name, input and output", () => {
    const lines = runLinesFromStoredReply(SES, STORED_TOOL).map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      type: "tool_use",
      sessionID: SES,
      part: {
        id: "call_test_tool",
        callID: "call_test_tool",
        messageID: "msg_test_tool",
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: { command: "echo hi-from-tool", description: "echo" }, output: "hi-from-tool\n" },
      },
    });
    expect(lines[1].part.reason).toBe("tool-calls");
  });

  it("replays a stored tool error with the error message as output", () => {
    const [line] = runLinesFromStoredReply(SES, STORED_TOOL_ERROR).map((l) => JSON.parse(l));
    expect(line.part.state).toEqual({ status: "error", input: { command: "echo hi" }, output: 'No tool named "bash" is currently available.' });
  });

  it("skips a tool that has no result yet, and a text block with no text", () => {
    const open: V2Message = {
      ...STORED_TEXT,
      time: { created: 1 },
      content: [
        { type: "tool", id: "call_open", name: "shell", state: { status: "running", input: {} } },
        { type: "text", text: "" },
        { type: "tool", name: "shell", state: { status: "completed" } },
      ],
      tokens: undefined,
    };
    expect(runLinesFromStoredReply(SES, open)).toEqual([]);
  });

  it("replays an error reply as an error line named after the v2 type", () => {
    const lines = runLinesFromStoredReply(SES, STORED_ERROR).map((l) => JSON.parse(l));
    expect(lines).toEqual([{ type: "error", sessionID: SES, error: { name: "provider.rate-limit", data: { message: "mock 429 (HTTP 429)" } } }]);
  });

  it("keeps the narration of an interrupted reply but not its aborted error", () => {
    const lines = runLinesFromStoredReply(SES, STORED_ABORTED).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["text"]);
  });
});

describe("v2ReplyIsDone", () => {
  it("is done for a completed reply that stopped", () => {
    expect(v2ReplyIsDone(STORED_TEXT)).toBe(true);
    expect(v2ReplyIsDone({ ...STORED_TEXT, finish: "length" })).toBe(true);
  });

  it("is not done after a tool round trip, an error, an unknown finish, or with no finish", () => {
    expect(v2ReplyIsDone(STORED_TOOL)).toBe(false);
    expect(v2ReplyIsDone(STORED_ERROR)).toBe(false);
    expect(v2ReplyIsDone({ ...STORED_TEXT, finish: "unknown" })).toBe(false);
    expect(v2ReplyIsDone({ ...STORED_TEXT, finish: undefined })).toBe(false);
  });

  it("is not done while the reply has not completed", () => {
    expect(v2ReplyIsDone({ ...STORED_TEXT, time: { created: 1, streamed: 2 } })).toBe(false);
    expect(v2ReplyIsDone({ id: "msg_open" })).toBe(false);
  });
});
