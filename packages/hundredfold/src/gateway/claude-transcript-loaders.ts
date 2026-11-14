import fs from "node:fs";
import path from "node:path";
import { claudeProjectsDirFor, type ClaudeProfile } from "../shared/claude-profile.js";
import { transcriptEntryText } from "./external-turns.js";

interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: TranscriptContentBlock[];
}

/**
 * The raw entries of a session's Claude Code JSONL transcript, read from the
 * projects dir of the profile the session ran on.
 */
export function loadRawTranscript(engineSessionId: string, profile: ClaudeProfile): TranscriptEntry[] {
  const jsonlPath = findTranscriptFile(engineSessionId, profile);
  if (!jsonlPath) return [];
  const entries: TranscriptEntry[] = [];
  for (const line of readJsonlLines(jsonlPath)) {
    try {
      const entry = rawEntryFromLine(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Messages from a Claude Code JSONL transcript file, read from the profile the
 * session ran on. Used as a fallback when the messages DB is empty
 * (pre-existing sessions).
 */
export function loadTranscriptMessages(engineSessionId: string, profile: ClaudeProfile): Array<{ role: string; content: string }> {
  const jsonlPath = findTranscriptFile(engineSessionId, profile);
  if (!jsonlPath) return [];
  const messages: Array<{ role: string; content: string }> = [];
  for (const line of readJsonlLines(jsonlPath)) {
    try {
      const text = transcriptEntryText(JSON.parse(line));
      if (text) messages.push(text);
    } catch {
      continue;
    }
  }
  return messages;
}

/** Claude Code stores transcripts in <config dir>/projects/<project-key>/<sessionId>.jsonl;
 *  search every project dir of the profile for the session's. */
function findTranscriptFile(engineSessionId: string, profile: ClaudeProfile): string | undefined {
  const claudeProjectsDir = claudeProjectsDirFor(profile);
  if (!fs.existsSync(claudeProjectsDir)) return undefined;
  for (const dir of fs.readdirSync(claudeProjectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) return jsonlPath;
  }
  return undefined;
}

function readJsonlLines(jsonlPath: string): string[] {
  return fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
}

function rawEntryFromLine(obj: { type?: unknown; message?: { content?: unknown } }): TranscriptEntry | undefined {
  const type = obj.type;
  if (type !== "user" && type !== "assistant") return undefined;
  if (!obj.message) return undefined;
  const blocks = blocksFromContent(obj.message.content);
  return blocks.length > 0 ? { role: type, content: blocks } : undefined;
}

function blocksFromContent(rawContent: unknown): TranscriptContentBlock[] {
  if (typeof rawContent === "string") return rawContent.trim() ? [{ type: "text", text: rawContent }] : [];
  if (!Array.isArray(rawContent)) return [];
  const blocks: TranscriptContentBlock[] = [];
  for (const block of rawContent) {
    if (!block || typeof block !== "object") continue;
    const converted = blockFromRaw(block as Record<string, unknown>);
    if (converted) blocks.push(converted);
  }
  return blocks;
}

function blockFromRaw(b: Record<string, unknown>): TranscriptContentBlock | undefined {
  switch (String(b.type || "")) {
    case "text":
      return { type: "text", text: String(b.text || "") };
    case "tool_use":
      return toolUseBlock(b);
    case "tool_result":
      return { type: "tool_result", text: toolResultText(b.content) };
    case "thinking":
      return thinkingBlock(b);
    default:
      return undefined;
  }
}

function toolUseBlock(b: Record<string, unknown>): TranscriptContentBlock {
  return { type: "tool_use", name: String(b.name || ""), input: (b.input as Record<string, unknown>) || {} };
}

function thinkingBlock(b: Record<string, unknown>): TranscriptContentBlock {
  return { type: "thinking", text: String(b.thinking || b.text || "") };
}

function toolResultText(resultContent: unknown): string {
  if (typeof resultContent === "string") return resultContent;
  if (!Array.isArray(resultContent)) return "";
  return (resultContent as Record<string, unknown>[])
    .filter((rc) => rc.type === "text")
    .map((rc) => String(rc.text || ""))
    .join("");
}
