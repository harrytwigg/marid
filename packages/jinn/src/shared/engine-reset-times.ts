/**
 * When an engine's rate-limit window reopens.
 *
 * The limits collector next door answers a different question — what to draw on
 * the Limits screen — and answers it for a person who is waiting on a render.
 * This asks for one number on behalf of a turn that has just failed, so it is
 * best effort by construction: an unreachable source resolves to `undefined`
 * rather than throwing or stalling, and the caller falls back to its own backoff.
 * The parsers themselves are the collector's, because the payload shapes are the
 * same ones it reads.
 */

import fs from "node:fs";
import { CLAUDE_LIMITS_DIR } from "./paths.js";
import { windowFromCodexRollout } from "./engine-limits.js";
import { claudeAccountKey } from "./engine-account.js";
import type { ClaudeProfile } from "./claude-profile.js";
import { lastAccountReading } from "./account-readings.js";
import {
  claudeSnapshotFile,
  fetchClaudeOAuthUsage,
  windowFromClaude,
  windowsFromClaudeUsage,
} from "./engine-limits-claude.js";

/**
 * The reset Codex stated in a `rate_limits` payload, in Unix seconds. Codex
 * writes the same snake_case snapshot into every `token_count` event, so the
 * live stream and the rollout on disk are read by the same parser.
 */
export function resetsAtFromCodexRateLimits(rateLimits: unknown): number | undefined {
  if (typeof rateLimits !== "object" || rateLimits === null) return undefined;
  const payload = rateLimits as Record<string, unknown>;
  return windowFromCodexRollout("5h", payload.primary)?.resetsAt
    ?? windowFromCodexRollout("7d", payload.secondary)?.resetsAt;
}

/** The 5h session window's reset from the account's most recent statusline snapshot. */
function claudeSnapshotResetsAt(account: string): number | undefined {
  const file = claudeSnapshotFile(CLAUDE_LIMITS_DIR, account);
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const rateLimits = parsed?.rate_limits;
    if (typeof rateLimits !== "object" || rateLimits === null) return undefined;
    return windowFromClaude("5h", (rateLimits as Record<string, unknown>).five_hour, 300)?.resetsAt;
  } catch {
    return undefined;
  }
}

/** Which account's window: a local profile (null is the default account), or a
 *  remote login by its account key, whose last reading the gateway keeps. */
export type ClaudeResetSource = { profile: ClaudeProfile } | { remoteAccount: string };

/**
 * When Claude's session window reopens, in Unix seconds — the number the
 * rate-limit backoff wants and that the stop-failure hook never carries. Two
 * sources, the live usage API first and the on-disk statusline snapshot behind
 * it, both read for the account that hit the limit (FR-071). A remote account
 * has neither on this host, so its last reading over SSH answers (FR-072). A
 * reset already in the past is no answer either, so it is discarded.
 */
export async function claudeResetsAtSeconds(nowMs: number = Date.now(), source: ClaudeResetSource = { profile: null }): Promise<number | undefined> {
  const stillAhead = (seconds: number | undefined) =>
    seconds !== undefined && seconds * 1000 > nowMs ? seconds : undefined;
  if ("remoteAccount" in source) {
    return stillAhead(lastAccountReading(source.remoteAccount)?.snapshot.windows?.find((window) => window.name === "5h")?.resetsAt);
  }
  try {
    const usage = await fetchClaudeOAuthUsage(process.env, source.profile);
    const live = usage ? windowsFromClaudeUsage(usage) : [];
    const session = stillAhead(live.find((window) => window.name === "5h")?.resetsAt);
    if (session !== undefined) return session;
  } catch {
    // The usage API is one of two sources; the on-disk snapshot is the other.
  }
  try {
    return stillAhead(claudeSnapshotResetsAt(claudeAccountKey(source.profile)));
  } catch {
    return undefined;
  }
}
