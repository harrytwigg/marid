import { describe, expect, it } from "vitest";
import {
  buildCompactCommand,
  buildResumeMessage,
  HANDOFF_FIELD_MAX_CHARS,
  isCompactCommand,
  parseCompactionHandoff,
  selfCompactionRefusal,
} from "../self-compaction.js";
import { isNativeClaudeCommand } from "../../engines/claude-interactive.js";

describe("self-compaction handoff", () => {
  it("requires goal, done and next, and trims them", () => {
    expect(parseCompactionHandoff({ goal: " g ", done: "d", next: "n" })).toEqual({
      ok: true,
      handoff: { goal: "g", done: "d", next: "n" },
    });
    for (const missing of ["goal", "done", "next"]) {
      const body: Record<string, unknown> = { goal: "g", done: "d", next: "n" };
      delete body[missing];
      const parsed = parseCompactionHandoff(body);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.error).toMatch(new RegExp(`^${missing} is required`));
    }
    const blank = parseCompactionHandoff({ goal: "g", done: "   ", next: "n" });
    expect(!blank.ok && blank.error).toMatch(/done is empty/);
  });

  it("keeps optional fields only when they say something", () => {
    const parsed = parseCompactionHandoff({ goal: "g", done: "d", next: "n", context: "  ", waitingOn: "child-1" });
    expect(parsed).toEqual({ ok: true, handoff: { goal: "g", done: "d", next: "n", waitingOn: "child-1" } });
  });

  it("refuses an over-long field rather than truncating it silently", () => {
    const parsed = parseCompactionHandoff({ goal: "g", done: "d", next: "n", context: "x".repeat(HANDOFF_FIELD_MAX_CHARS.context + 1) });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/context is 6001 characters, over its 6000-character cap/);
  });

  it("refuses non-string fields", () => {
    const parsed = parseCompactionHandoff({ goal: "g", done: 3, next: "n" });
    expect(!parsed.ok && parsed.error).toBe("done must be a string");
  });
});

describe("self-compaction engine support", () => {
  it("drives claude, and opencode only in server mode", () => {
    expect(selfCompactionRefusal("claude", undefined)).toBeUndefined();
    expect(selfCompactionRefusal("opencode", "server")).toBeUndefined();
    expect(selfCompactionRefusal("opencode", "run")).toMatch(/server mode/);
    expect(selfCompactionRefusal("opencode", undefined)).toMatch(/server mode/);
    expect(selfCompactionRefusal("codex", undefined)).toMatch(/codex engine has no native compaction/);
  });
});

describe("the compaction turn prompt", () => {
  it("is a single-line /compact command both engines recognise", () => {
    const command = buildCompactCommand({ goal: "Ship\nTASK-1\n\nwith   tests" });
    expect(command.startsWith("/compact ")).toBe(true);
    expect(command).not.toMatch(/\n/);
    expect(command).toMatch(/Current goal: Ship TASK-1 with tests$/);
    expect(isCompactCommand(command)).toBe(true);
    // The claude engine must route it through its native-command path, or the
    // TUI would receive it as text for the model instead of running it.
    expect(isNativeClaudeCommand(command)).toBe(true);
  });

  it("clips a long goal so the command stays a short line", () => {
    const command = buildCompactCommand({ goal: "y".repeat(2000) });
    expect(command.length).toBeLessThan(800);
    expect(command.endsWith("…")).toBe(true);
  });

  it("recognises /compact and nothing that merely starts with it", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact keep ids")).toBe(true);
    expect(isCompactCommand("/compaction please")).toBe(false);
    expect(isCompactCommand("please /compact")).toBe(false);
  });
});

describe("the resume turn", () => {
  it("delivers the handoff verbatim under its headings and tells the agent to carry on", () => {
    const message = buildResumeMessage({
      goal: "Ship TASK-1",
      done: "- route\n- tests",
      next: "1. open PR",
      context: "branch feat/x",
      waitingOn: "session abc: QA findings",
    });
    expect(message).toMatch(/^\[Self-compaction resume\]/);
    expect(message).toMatch(/Resume the work now from "Next"/);
    // The handoff is exact, not newer than everything: the summary may show later work.
    expect(message).toMatch(/anything the summary shows happening after you wrote it is newer than it/);
    expect(message).toContain("## Goal\nShip TASK-1");
    expect(message).toContain("## Done\n- route\n- tests");
    expect(message).toContain("## Next\n1. open PR");
    expect(message).toContain("## Context\nbranch feat/x");
    expect(message).toContain("## Waiting on\nsession abc: QA findings");
    expect(message).toMatch(/Replies from these arrive as their own messages/);
  });

  it("omits the optional sections when there is nothing in them", () => {
    const message = buildResumeMessage({ goal: "g", done: "d", next: "n" });
    expect(message).not.toContain("## Context");
    expect(message).not.toContain("## Waiting on");
  });
});
