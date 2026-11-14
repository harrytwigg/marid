import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_TRANSCRIPT_TAIL_BYTES,
  lastContextTokensInTranscriptText,
  readRemoteContextTokens,
  remoteTranscriptTailCommand,
} from "../remote-transcript-context.js";

/**
 * A remote Claude session's context figure comes from the end of its transcript on
 * its own host. Without it the meter stays on "n/a" for the life of the session.
 */

const assistant = (input: number, cacheRead: number, cacheCreate: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { id: `m${input}`, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 9 } }, ...extra });

describe("lastContextTokensInTranscriptText", () => {
  it("reads the newest assistant entry's input, cache-read and cache-creation tokens", () => {
    const text = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      assistant(10, 1000, 500),
      JSON.stringify({ type: "user", message: { content: "more" } }),
      assistant(20, 40_000, 2_000),
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
    ].join("\n");
    expect(lastContextTokensInTranscriptText(text)).toBe(42_020);
  });

  it("skips a first line cut by the tail, and blank or unparseable lines", () => {
    const cut = assistant(1, 1, 1).slice(30);
    expect(lastContextTokensInTranscriptText(["", cut, "not json", assistant(5, 100, 0)].join("\n"))).toBe(105);
  });

  it("is undefined when the transcript has no usage to read", () => {
    expect(lastContextTokensInTranscriptText(JSON.stringify({ type: "user" }))).toBeUndefined();
    expect(lastContextTokensInTranscriptText("")).toBeUndefined();
  });
});

describe("remoteTranscriptTailCommand", () => {
  it("tails one quoted absolute .jsonl path, bounded", () => {
    expect(remoteTranscriptTailCommand("/home/harry/.claude/projects/-srv/abc.jsonl"))
      .toBe(`tail -c ${REMOTE_TRANSCRIPT_TAIL_BYTES} -- '/home/harry/.claude/projects/-srv/abc.jsonl'`);
    expect(remoteTranscriptTailCommand("/tmp/it's.jsonl")).toContain(`'/tmp/it'\\''s.jsonl'`);
  });

  it("reads nothing else: not a relative path, another extension, or one with a newline", () => {
    expect(remoteTranscriptTailCommand("projects/abc.jsonl")).toBeUndefined();
    expect(remoteTranscriptTailCommand("/etc/passwd")).toBeUndefined();
    expect(remoteTranscriptTailCommand("/tmp/a.jsonl\nrm -rf /")).toBeUndefined();
  });
});

describe("readRemoteContextTokens", () => {
  const path = "/home/harry/.claude/projects/-srv/abc.jsonl";

  it("asks the host for the tail and returns the figure", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: assistant(3, 70_000, 1_000) + "\n", stderr: "" }));
    await expect(readRemoteContextTokens("harry@box", path, run as never)).resolves.toBe(71_003);
    expect(run).toHaveBeenCalledWith("harry@box", [expect.stringContaining("tail -c")], expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("is undefined, not an error, when the host is unreachable or the read fails", async () => {
    for (const res of [{ code: 255, stdout: "", stderr: "ssh: connect" }, { code: null, stdout: "", stderr: "" }, { code: 1, stdout: "", stderr: "No such file" }]) {
      await expect(readRemoteContextTokens("harry@box", path, vi.fn(async () => res) as never)).resolves.toBeUndefined();
    }
    await expect(readRemoteContextTokens("harry@box", path, vi.fn(async () => { throw new Error("spawn failed"); }) as never)).resolves.toBeUndefined();
  });

  it("does not reach out for a path it will not read", async () => {
    const run = vi.fn();
    await expect(readRemoteContextTokens("harry@box", "/etc/passwd", run as never)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
