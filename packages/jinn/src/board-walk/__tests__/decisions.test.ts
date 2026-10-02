import { describe, expect, it } from "vitest";
import { readStartDecision, readTodoDecision } from "../decisions.js";
import { lockedDownEmployee } from "../route-turn.js";
import type { Employee } from "../../shared/types.js";

describe("reading one decision", () => {
  it("reads a decision with its gates", () => {
    expect(readTodoDecision({
      id: " T-1 ", verdict: "ready", action: "release", reason: "met",
      gates: [{ kind: "date", date: "2026-09-30", quote: "not before 2026-09-30" }, { kind: "blocker", id: "T-2" }, { kind: "pr", url: "https://github.com/a/b/pull/1" }],
    })).toEqual({ ok: true, decision: {
      id: "T-1", verdict: "ready", action: "release", reason: "met",
      gates: [{ kind: "date", date: "2026-09-30", quote: "not before 2026-09-30" }, { kind: "blocker", id: "T-2" }, { kind: "pr", url: "https://github.com/a/b/pull/1" }],
    } });
    expect(readTodoDecision({ id: "T-1", verdict: "gated", action: "leave", reason: "waits" })).toEqual({ ok: true, decision: { id: "T-1", verdict: "gated", action: "leave", reason: "waits" } });
  });

  it("refuses rather than guesses, and says what is wrong", () => {
    expect(readTodoDecision({ verdict: "ready", action: "leave", reason: "x" })).toEqual({ ok: false, problem: "the decision names no Todo id" });
    expect(readTodoDecision({ id: "T-1", verdict: "ready", action: "none", reason: "x" })).toEqual({ ok: false, problem: 'action "none" is not one of release, park, flag, leave' });
    expect(readTodoDecision({ id: "T-1", verdict: "ready", action: "leave" })).toEqual({ ok: false, problem: "the decision gives no reason" });
    // A gate the gateway could not check is never dropped silently: the whole
    // decision is refused, so a release cannot ride on the gates that did parse.
    expect(readTodoDecision({ id: "T-1", verdict: "ready", action: "release", reason: "x", gates: [{ kind: "date", date: "2026-09-30" }] }))
      .toMatchObject({ ok: false, problem: expect.stringContaining("some gates cannot be read") });
  });

  it("reads a start, and refuses one with no reason", () => {
    expect(readStartDecision({ id: "T-1", reason: "spare capacity", engine: "codex" })).toEqual({ ok: true, decision: { id: "T-1", reason: "spare capacity", engine: "codex" } });
    expect(readStartDecision({ id: "T-1" })).toEqual({ ok: false, problem: "a start needs a Todo id and a reason" });
  });
});

describe("the walk's turn has only the walk's tools", () => {
  it("runs as the employee on Claude, on the gateway, with the board-walk toolset alone, no built-in tools and none of its own flags", () => {
    const employee = {
      name: "assistant", engine: "opencode", model: "x", cliFlags: ["--agent", "build"], mcp: true,
      remoteHost: "box", remoteUser: "u", remoteCwd: "/w",
    } as unknown as Employee;
    expect(lockedDownEmployee(employee, "sonnet")).toEqual({
      name: "assistant", engine: "claude", model: "sonnet", mcp: false, jinnMcp: false, toolset: "board-walk",
      cliFlags: ["--no-chrome", "--tools", "", "--strict-mcp-config"],
    });
    const onClaude = { name: "assistant", engine: "claude", model: "opus", cliFlags: ["--chrome"] } as unknown as Employee;
    expect(lockedDownEmployee(onClaude, "sonnet")).toMatchObject({ engine: "claude", model: "opus", cliFlags: ["--no-chrome", "--tools", "", "--strict-mcp-config"] });
  });
});
