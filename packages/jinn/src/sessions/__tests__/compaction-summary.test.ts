import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitSummaryFromTranscript, summaryFromTranscript, SUMMARY_MAX_CHARS } from "../compaction-summary.js";
import { summaryReport } from "../../engines/opencode-server-compaction.js";

/** A transcript in the shapes Claude Code writes around a manual `/compact`. */
const OPENING = "This session is being continued from a previous conversation that ran out of context.";
const at = (ms: number) => new Date(ms).toISOString();
const boundary = (ms: number) => ({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 900, postTokens: 100 }, timestamp: at(ms) });
const summary = (text: string, ms: number, content: unknown = text) => ({ type: "user", isCompactSummary: true, message: { role: "user", content }, timestamp: at(ms) });
const user = (text: string, ms: number) => ({ type: "user", message: { role: "user", content: text }, timestamp: at(ms) });
const commandEntries = (ms: number) => [
  user("<command-name>/compact</command-name>\n<command-args>keep it</command-args>", ms),
  user("<local-command-stdout>Compacted</local-command-stdout>", ms + 1),
];

let dir: string;
let file: string;
const write = (...entries: unknown[]) => fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
const START = 1_800_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-summary-"));
  file = path.join(dir, "thread.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("summaryFromTranscript", () => {
  it("reads the marked summary after the boundary, past the command entries a manual /compact writes", () => {
    write(user("earlier work", START - 5000), ...commandEntries(START + 10), boundary(START + 20), summary(`${OPENING} the real one`, START + 21), user("<local-command-stdout>Compacted</local-command-stdout>", START + 22));
    expect(summaryFromTranscript(file, START)).toBe(`${OPENING} the real one`);
  });

  it("parses only the lines that can be a boundary or a summary, and still finds a summary known only by its opening", () => {
    const filler = Array.from({ length: 500 }, (_, index) => user(`unrelated work ${index}`, START - 1000 + index));
    write(...filler, boundary(START + 20), ...filler, { type: "user", message: { role: "user", content: `${OPENING} unmarked` }, timestamp: at(START + 21) }, ...filler);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(summaryFromTranscript(file, START)).toBe(`${OPENING} unmarked`);
      expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      parse.mockRestore();
    }
  });

  it("is undefined with no boundary, and with a boundary and no summary after it yet", () => {
    write(user("hello", START + 1), ...commandEntries(START + 2));
    expect(summaryFromTranscript(file, START)).toBeUndefined();
    write(...commandEntries(START + 2), boundary(START + 3));
    expect(summaryFromTranscript(file, START)).toBeUndefined();
  });

  it("is undefined for a missing or unreadable transcript", () => {
    expect(summaryFromTranscript(path.join(dir, "nope.jsonl"), START)).toBeUndefined();
    fs.writeFileSync(file, "not json\n{broken\n");
    expect(summaryFromTranscript(file, START)).toBeUndefined();
  });

  it("ignores a boundary older than the turn: an earlier compaction's summary is not this one's", () => {
    write(boundary(START - 60_000), summary(`${OPENING} old`, START - 59_000), user("later work", START - 1000));
    expect(summaryFromTranscript(file, START)).toBeUndefined();
  });

  it("takes the newest current boundary's summary when there are two", () => {
    write(boundary(START + 10), summary(`${OPENING} first`, START + 11), boundary(START + 50), summary(`${OPENING} second`, START + 51));
    expect(summaryFromTranscript(file, START)).toBe(`${OPENING} second`);
  });

  it("does not take an old boundary's summary when only the newer boundary has none yet", () => {
    write(boundary(START - 100), summary(`${OPENING} stale`, START - 99), boundary(START + 50));
    expect(summaryFromTranscript(file, START)).toBeUndefined();
  });

  it("reads array content, joining its text parts", () => {
    write(boundary(START + 1), summary("", START + 2, [{ type: "text", text: `${OPENING} part one` }, { type: "tool_result" }, { type: "text", text: "part two" }]));
    expect(summaryFromTranscript(file, START)).toBe(`${OPENING} part one\npart two`);
  });

  it("falls back to the opening sentence when the marker is absent, and prefers the marker when both exist", () => {
    write(boundary(START + 1), user("<local-command-stdout>x</local-command-stdout>", START + 2), user(`${OPENING} by sentence`, START + 3));
    expect(summaryFromTranscript(file, START)).toBe(`${OPENING} by sentence`);
    write(boundary(START + 1), user(`${OPENING} by sentence`, START + 2), summary(`${OPENING} by marker`, START + 3));
    expect(summaryFromTranscript(file, START)).toBe(`${OPENING} by marker`);
  });

  it("does not take an ordinary user message as the summary", () => {
    write(boundary(START + 1), user("just a question", START + 2), user("<command-name>/compact</command-name>", START + 3));
    expect(summaryFromTranscript(file, START)).toBeUndefined();
  });

  it("returns an over-cap summary whole: the caller refuses it, nothing is truncated here", () => {
    const long = `${OPENING} ${"x".repeat(SUMMARY_MAX_CHARS)}`;
    write(boundary(START + 1), summary(long, START + 2));
    expect(summaryFromTranscript(file, START)).toHaveLength(long.length);
  });
});

describe("awaitSummaryFromTranscript", () => {
  it("finds a summary that lands inside the poll window, after PostCompact had already fired", async () => {
    write(...commandEntries(START + 1));
    setTimeout(() => write(...commandEntries(START + 1), boundary(START + 20), summary(`${OPENING} late`, START + 21)), 150);
    expect(await awaitSummaryFromTranscript(file, START, 2000, 25)).toBe(`${OPENING} late`);
  });

  it("gives up after the window with nothing, and does not wait at all for a transcript that is not there", async () => {
    write(...commandEntries(START + 1));
    const t0 = Date.now();
    expect(await awaitSummaryFromTranscript(file, START, 200, 25)).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    const t1 = Date.now();
    expect(await awaitSummaryFromTranscript(path.join(dir, "absent.jsonl"), START, 2000, 25)).toBeUndefined();
    expect(Date.now() - t1).toBeLessThan(500);
  });
});

describe("summaryReport (opencode server)", () => {
  const message = (info: Record<string, unknown>, text?: string) => ({ info, parts: text === undefined ? [] : [{ type: "text", text }] });

  it("returns the text parts of the summary message, joined", () => {
    const messages = [
      message({ role: "assistant", tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } } }, "an ordinary reply"),
      { info: { role: "assistant", summary: true, mode: "compaction", cost: 0.01 }, parts: [{ type: "text", text: "Goal: ship it." }, { type: "reasoning", text: "hidden" }, { type: "text", text: "Done: tests." }] },
      message({ role: "user" }, "re-seeded system prompt"),
    ];
    expect(summaryReport(messages).summary).toBe("Goal: ship it.\nDone: tests.");
  });

  it("has no summary when there is no summary message, or it has no text", () => {
    expect(summaryReport([message({ role: "assistant" }, "hello")]).summary).toBeUndefined();
    expect(summaryReport([message({ role: "assistant", summary: true }, undefined)]).summary).toBeUndefined();
  });
});
