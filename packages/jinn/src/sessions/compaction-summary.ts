import fs from "node:fs";

/**
 * Reading back the summary a Claude `/compact` wrote, for a session that is moving to
 * another conversation and carries it over (see `pending-switch.ts`).
 *
 * Claude Code appends a `compact_boundary` system entry, then a user entry marked
 * `isCompactSummary: true` whose text starts "This session is being continued from a
 * previous conversation". A manual `/compact` also writes `<command-name>` and
 * `<local-command-stdout>` user entries near the boundary, so the first user entry after
 * the boundary is not the summary. The reader keys on the marker, falls back to the
 * opening sentence, takes string or array content, and only trusts a boundary written at or
 * after the compaction turn started: an earlier compaction's summary is not this one's.
 */

/** Past this the summary is not used: it would be most of the new conversation's first prompt, and truncating it would hide that it was cut. */
export const SUMMARY_MAX_CHARS = 24_000;

const SUMMARY_OPENING = "This session is being continued from a previous conversation";
/** PostCompact fires before Claude Code appends the boundary (25 ms apart on 2.1.284), so a read at settle finds nothing yet. */
const SUMMARY_WAIT_MS = 2_000;
const SUMMARY_POLL_MS = 100;

interface TranscriptEntry {
  type?: unknown;
  subtype?: unknown;
  isCompactSummary?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

function parseLine(line: string): TranscriptEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as TranscriptEntry : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a line can be a boundary or a summary candidate; the rest of a long transcript is not parsed. */
function mattersToSummary(line: string): boolean {
  return line.includes("compact_boundary") || line.includes("isCompactSummary") || line.includes(SUMMARY_OPENING);
}

function entryTimeMs(entry: TranscriptEntry): number | undefined {
  const raw = entry.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A user entry's text: its content as a string, or its text parts joined. */
function contentText(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Whether the entry is a compaction boundary written at or after `afterMs` (one with no time is taken, as the stats reader does). */
function isCurrentBoundary(entry: TranscriptEntry, afterMs: number): boolean {
  if (entry.type !== "system" || entry.subtype !== "compact_boundary") return false;
  const at = entryTimeMs(entry);
  return at === undefined || at >= afterMs;
}

/** A user entry that is (or opens as) the summary, and which of the two it is. */
function summaryCandidate(entry: TranscriptEntry): { kind: "marked" | "opening"; text: string } | undefined {
  if (entry.type !== "user") return undefined;
  const text = contentText(entry).trim();
  if (!text) return undefined;
  if (entry.isCompactSummary === true) return { kind: "marked", text };
  return text.startsWith(SUMMARY_OPENING) ? { kind: "opening", text } : undefined;
}

/** What the reader has found since the newest current boundary; a newer boundary starts over. */
interface Found {
  marked?: string;
  opening?: string;
}

/** Take one entry into the reading: a current boundary resets it, and a summary candidate after one is kept (the first of its kind). */
function take(found: Found | undefined, entry: TranscriptEntry, afterMs: number): Found | undefined {
  if (isCurrentBoundary(entry, afterMs)) return {};
  const candidate = found ? summaryCandidate(entry) : undefined;
  if (found && candidate) found[candidate.kind] ??= candidate.text;
  return found;
}

/**
 * The summary the newest boundary at or after `afterMs` is followed by: the first user entry
 * marked `isCompactSummary`, else the first whose text opens as Claude Code's summary does.
 * Undefined when there is no such boundary or no summary after it yet. Exported for tests.
 */
export function summaryFromTranscript(transcriptPath: string, afterMs: number): string | undefined {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let found: Found | undefined;
  for (const line of content.split("\n")) {
    const entry = mattersToSummary(line) ? parseLine(line) : undefined;
    if (entry) found = take(found, entry, afterMs);
  }
  return found?.marked ?? found?.opening;
}

/** Wait for the summary to reach the transcript, up to `waitMs`. A transcript that cannot be read at all (another host) is not waited on. Exported for tests. */
export async function awaitSummaryFromTranscript(
  transcriptPath: string,
  afterMs: number,
  waitMs = SUMMARY_WAIT_MS,
  pollMs = SUMMARY_POLL_MS,
): Promise<string | undefined> {
  if (!fs.existsSync(transcriptPath)) return undefined;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const summary = summaryFromTranscript(transcriptPath, afterMs);
    if (summary !== undefined || Date.now() >= deadline) return summary;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
