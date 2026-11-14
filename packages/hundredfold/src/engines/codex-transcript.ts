/**
 * Reading facts back out of a Codex rollout transcript.
 *
 * The headless `--json` stream carries neither the context total nor the
 * account's rate limits, but codex writes both into every `token_count` event of
 * the rollout it is already keeping on disk. That file is the only structured
 * source we have for either, so this module is the one place that knows how to
 * find a thread's rollout and walk it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineResult } from "../shared/types.js";
import { classifyEngineFailureText, hasEngineFailureClass } from "../shared/engine-failure.js";
import { resetsAtFromCodexRateLimits } from "../shared/engine-reset-times.js";

export const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function codexSessionIdFromTranscript(filePath: string): string | undefined {
  try {
    const first = fs.readFileSync(filePath, "utf-8").split("\n", 1)[0];
    const msg = JSON.parse(first);
    const id = msg?.payload?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

function latestCodexTranscript(sessionId: string, root: string): string | undefined {
  return walkJsonl(root)
    .map((file) => {
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; }
      catch { return undefined; }
    })
    .filter((entry): entry is { file: string; mtimeMs: number } => !!entry)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .find(({ file }) => codexSessionIdFromTranscript(file) === sessionId)?.file;
}

/**
 * Walk a thread's rollout `token_count` payloads oldest-first. Codex writes one
 * for every turn, so the readers over it all share this walk.
 */
function tokenCountPayload(line: string): any | undefined {
  if (!line.trim()) return undefined;
  try {
    const msg = JSON.parse(line);
    return msg?.type === "event_msg" && msg?.payload?.type === "token_count" ? msg.payload : undefined;
  } catch {
    return undefined;
  }
}

export function forEachCodexTokenCount(sessionId: string, root: string, visit: (payload: any) => void): void {
  const file = latestCodexTranscript(sessionId, root);
  if (!file) return;
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const payload = tokenCountPayload(line);
      if (payload) visit(payload);
    }
  } catch {
    // A missing or half-written rollout is a missing reading, not a failure.
  }
}

/** When codex last said its rate-limit window reopens, in Unix seconds. */
export function lastCodexTranscriptResetsAt(sessionId: string, root = CODEX_SESSIONS_DIR): number | undefined {
  let last: number | undefined;
  forEachCodexTokenCount(sessionId, root, (payload) => {
    const resetsAt = resetsAtFromCodexRateLimits(payload.rate_limits);
    if (resetsAt !== undefined) last = resetsAt;
  });
  return last;
}

/**
 * The rate-limit reading for a failed turn, or nothing at all.
 *
 * Codex states its reset in the `rate_limits` snapshot it writes to the rollout
 * for every `token_count`; the error prose is the fallback for a turn that died
 * before one landed. When neither source names a time, `resetsAt` is left absent
 * so the retry machinery uses its own backoff — a made-up reset would be worse
 * than no reset, because it would be believed.
 */
export function codexRateLimitFor(
  error: string | undefined,
  threadId: string,
  sessionsDir: string,
): Pick<EngineResult, "rateLimit"> {
  if (!error) return {};
  const classification = classifyEngineFailureText(error);
  if (!hasEngineFailureClass(classification, "rate-limit", "quota")) return {};
  const resetsAt = (threadId ? lastCodexTranscriptResetsAt(threadId, sessionsDir) : undefined)
    ?? classification.resetsAt;
  return { rateLimit: { status: "rejected", ...(resetsAt === undefined ? {} : { resetsAt }) } };
}
