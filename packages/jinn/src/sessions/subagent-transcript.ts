import fs from "node:fs";
import path from "node:path";
import type { SubagentEntry, SubagentTranscriptResponse } from "../shared/subagent-transcript.js";

/** What the gateway reads of a transcript, from its end: a long sub-agent is shown from where this starts. */
export const SUBAGENT_READ_BYTES = 4 * 1024 * 1024;
const TEXT_MAX = 20_000;
const INPUT_MAX = 2_000;
const RESULT_MAX = 4_000;

/** An agent id is a path segment of the file name: letters, digits, `-` and `_` only. */
export function isAgentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/** `<parent transcript without .jsonl>/subagents/agent-<agentId>.jsonl`, where Claude Code writes it. */
export function subagentTranscriptPath(parentTranscript: string, agentId: string): string {
  return path.join(parentTranscript.replace(/\.jsonl$/, ""), "subagents", `agent-${agentId}.jsonl`);
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Raw : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function instant(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** A tool result's text: a string, or the text blocks of a list. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (record(part)?.type === "text" ? String(record(part)?.text ?? "") : "")).join("");
}

/** The call's input as a short line or two: the command, path or pattern when it has one, else its JSON. */
function inputSummary(input: unknown): string {
  const fields = record(input);
  if (!fields) return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof fields[key] === "string" && fields[key]) return clip(fields[key] as string, INPUT_MAX);
  }
  return Object.keys(fields).length ? clip(JSON.stringify(fields), INPUT_MAX) : "";
}

interface Fold {
  entries: SubagentEntry[];
  tools: Map<string, Extract<SubagentEntry, { kind: "tool" }>>;
}

function addText(fold: Fold, role: "user" | "assistant", text: string, at: string | null): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const kind = role === "assistant" ? "text" : "prompt";
  fold.entries.push({ kind, text: clip(trimmed, TEXT_MAX), at });
}

function addBlock(fold: Fold, role: "user" | "assistant", block: Raw, at: string | null): void {
  if (block.type === "text" && typeof block.text === "string") {
    addText(fold, role, block.text, at);
  } else if (block.type === "tool_use" && typeof block.id === "string") {
    const entry = { kind: "tool" as const, id: block.id, name: String(block.name ?? ""), input: inputSummary(block.input), result: null, isError: false, at };
    fold.tools.set(block.id, entry);
    fold.entries.push(entry);
  } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
    const call = fold.tools.get(block.tool_use_id);
    if (call) {
      call.result = clip(resultText(block.content), RESULT_MAX);
      call.isError = block.is_error === true;
    }
  }
}

function addLine(fold: Fold, line: unknown): void {
  const obj = record(line);
  const role = obj?.type;
  if (role !== "user" && role !== "assistant") return;
  const message = record(obj?.message);
  const at = instant(obj?.timestamp);
  const content = message?.content;
  if (typeof content === "string") return addText(fold, role, content, at);
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const fields = record(block);
    if (fields) addBlock(fold, role, fields, at);
  }
}

/** The conversation a sub-agent's JSONL lines hold: what it was asked, what it said, and each tool call with its result. */
export function parseSubagentTranscript(lines: readonly string[]): SubagentEntry[] {
  const fold: Fold = { entries: [], tools: new Map() };
  for (const line of lines) {
    try {
      addLine(fold, JSON.parse(line));
    } catch {
      continue; // A line still being written.
    }
  }
  return fold.entries;
}

/** The last `SUBAGENT_READ_BYTES` of a file as lines; a cut first line is dropped. */
function readLines(file: string): { lines: string[]; truncated: boolean; updatedAt: Date } {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, SUBAGENT_READ_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString("utf-8").split("\n");
    const truncated = stat.size > length;
    if (truncated) lines.shift();
    return { lines: lines.filter(Boolean), truncated, updatedAt: stat.mtime };
  } finally {
    fs.closeSync(fd);
  }
}

/** The sub-agent's transcript at `file`, or why it cannot be shown. */
export function readSubagentTranscript(ids: { sessionId: string; agentId: string }, file: string | undefined): SubagentTranscriptResponse {
  if (!file) return { ...ids, available: false, reason: "not-found" };
  try {
    const { lines, truncated, updatedAt } = readLines(file);
    return { ...ids, available: true, entries: parseSubagentTranscript(lines), truncated, updatedAt: updatedAt.toISOString() };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { ...ids, available: false, reason: missing ? "not-found" : "unreadable" };
  }
}
