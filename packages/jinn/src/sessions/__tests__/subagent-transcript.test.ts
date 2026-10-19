import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SUBAGENT_READ_BYTES,
  isAgentId,
  parseSubagentTranscript,
  readSubagentTranscript,
  subagentTranscriptPath,
} from "../subagent-transcript.js";

const line = (obj: unknown) => JSON.stringify(obj);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-transcript-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ids = { sessionId: "s1", agentId: "a0123456789abcdef" };

const prompt = line({ type: "user", isSidechain: true, timestamp: "2026-10-16T10:00:00.000Z", message: { role: "user", content: "Count the lines." } });
const call = line({ type: "assistant", timestamp: "2026-10-16T10:00:01.000Z", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "wc -l notes.txt", description: "count" } }] } });
const result = line({ type: "user", timestamp: "2026-10-16T10:00:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 notes.txt", is_error: false }] } });
const answer = line({ type: "assistant", timestamp: "2026-10-16T10:00:03.000Z", message: { content: [{ type: "text", text: "One line." }] } });

describe("parseSubagentTranscript", () => {
  it("folds a tool result into its call and keeps the prompt and the answer", () => {
    expect(parseSubagentTranscript([prompt, call, result, answer])).toEqual([
      { kind: "prompt", text: "Count the lines.", at: "2026-10-16T10:00:00.000Z" },
      { kind: "tool", id: "tu1", name: "Bash", input: "wc -l notes.txt", result: "1 notes.txt", isError: false, at: "2026-10-16T10:00:01.000Z" },
      { kind: "text", text: "One line.", at: "2026-10-16T10:00:03.000Z" },
    ]);
  });

  it("shows a call with no result yet as still running", () => {
    const [, tool] = parseSubagentTranscript([prompt, call]);
    expect(tool).toMatchObject({ kind: "tool", result: null, isError: false });
  });

  it("skips bookkeeping lines, empty thinking and a line still being written", () => {
    const thinking = line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } });
    const entries = parseSubagentTranscript([line({ type: "attachment" }), line({ type: "api-request" }), thinking, '{"type":"assis', answer]);
    expect(entries).toEqual([{ kind: "text", text: "One line.", at: "2026-10-16T10:00:03.000Z" }]);
  });

  it("reads a result given as text blocks and marks an error", () => {
    const failed = line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: [{ type: "text", text: "no " }, { type: "text", text: "such file" }] }] } });
    const [, tool] = parseSubagentTranscript([prompt, call, failed]);
    expect(tool).toMatchObject({ result: "no such file", isError: true });
  });

  it("summarises a call by its command, path or pattern, else its input", () => {
    const use = (input: unknown) => line({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "T", input }] } });
    const [read, other] = parseSubagentTranscript([use({ file_path: "/a/b.ts", offset: 3 }), use({ depth: 2 })]);
    expect(read).toMatchObject({ input: "/a/b.ts" });
    expect(other).toMatchObject({ input: '{"depth":2}' });
  });

  it("clips long text and results", () => {
    const big = "x".repeat(30_000);
    const longCall = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu9", name: "Bash", input: { command: "ls" } }] } });
    const longResult = line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu9", content: big }] } });
    const longText = line({ type: "assistant", message: { content: [{ type: "text", text: big }] } });
    const [tool, text] = parseSubagentTranscript([longCall, longResult, longText]);
    expect((tool as { result: string }).result).toHaveLength(4_001);
    expect((text as { text: string }).text).toHaveLength(20_001);
  });
});

describe("subagentTranscriptPath", () => {
  it("is the subagents folder beside the parent's transcript", () => {
    expect(subagentTranscriptPath("/p/proj/abc.jsonl", "a1")).toBe("/p/proj/abc/subagents/agent-a1.jsonl");
  });

  it("accepts only ids that are a file name", () => {
    expect(isAgentId("a0123456789abcdef")).toBe(true);
    for (const bad of ["", "../x", "a/b", "a b", "a.jsonl", "x".repeat(81)]) expect(isAgentId(bad)).toBe(false);
  });
});

describe("readSubagentTranscript", () => {
  it("reads a file and reports when it was last written", () => {
    const file = path.join(dir, "ok.jsonl");
    fs.writeFileSync(file, `${[prompt, call, result].join("\n")}\n`);
    const out = readSubagentTranscript(ids, file);
    expect(out).toMatchObject({ ...ids, available: true, truncated: false, updatedAt: expect.any(String) });
    expect(out.available && out.entries).toHaveLength(2);
  });

  it("says not-found for no path and for a missing file", () => {
    expect(readSubagentTranscript(ids, undefined)).toEqual({ ...ids, available: false, reason: "not-found" });
    expect(readSubagentTranscript(ids, path.join(dir, "missing.jsonl"))).toEqual({ ...ids, available: false, reason: "not-found" });
  });

  it("says unreadable for a file it cannot read", () => {
    expect(readSubagentTranscript(ids, dir)).toEqual({ ...ids, available: false, reason: "unreadable" });
  });

  it("reads only the end of a very large file and says so", () => {
    const file = path.join(dir, "big.jsonl");
    const filler = line({ type: "assistant", message: { content: [{ type: "text", text: "y".repeat(1000) }] } });
    const count = Math.ceil(SUBAGENT_READ_BYTES / (filler.length + 1)) + 50;
    fs.writeFileSync(file, `${prompt}\n${Array(count).fill(filler).join("\n")}\n${answer}\n`);
    const out = readSubagentTranscript(ids, file);
    expect(out.available && out.truncated).toBe(true);
    const entries = out.available ? out.entries : [];
    expect(entries.some((entry) => entry.kind === "prompt")).toBe(false);
    expect(entries.at(-1)).toMatchObject({ kind: "text", text: "One line." });
  });
});
