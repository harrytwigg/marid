import type { GatewayEmit } from "../shared/gateway-events.js";
import type { HundredfoldConfig, JsonObject } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { rateLimitEngineLabel } from "../shared/rateLimit.js";
import { insertMessage } from "./registry.js";
import { describeSwitchTarget, type SwitchTargetView } from "./switch-target.js";

/**
 * The transcript's record of a switch: what `transportMeta.lastSwitch` holds, and the
 * `notification` message that carries it (`meta.sessionSwitch`) so the operator sees every
 * switch, whoever asked for it and whether or not it happened.
 */

export type SwitchCarryOver = "same-conversation" | "summary" | "manual-handover" | "transcript-pointer";

export interface LastSwitch {
  at: string;
  by: "operator" | "session";
  from: SwitchTargetView;
  to: SwitchTargetView;
  /** False when a requested switch did not happen: the session stayed on `from`, and `reason` says why. */
  applied: boolean;
  carryOver: SwitchCarryOver;
  /** Why a switch did not happen, or why a compaction failed before a manual handover. */
  reason?: string;
  /** The engine the compaction ran on, when it was not `from`'s (a session on a stand-in engine). */
  compactedOn?: string;
  /** The left Claude conversation's transcript path, computed before the write (unscoped sessions only). */
  leftTranscript?: string;
}

const FAILURE_PHRASES: Record<string, string> = {
  error: "an error",
  "usage-limit": "usage limit",
  unconfirmed: "it could not be confirmed",
  "no-summary": "no summary was produced",
  "summary-too-long": "the summary was too long",
  "no-outcome": "it did not finish",
};

/** Why a compaction left no summary, in words: the failure reason, or that the engine has no compaction at all. */
export function compactionFailureText(reason: string | undefined, fromEngine: string): string {
  if (reason === "not-supported") return `${rateLimitEngineLabel(fromEngine)} has no compaction`;
  return `the compaction failed (${FAILURE_PHRASES[reason ?? ""] ?? reason ?? "unknown"})`;
}

function requestedBy(by: LastSwitch["by"]): string {
  return by === "operator" ? "changed by the operator" : "requested by this session";
}

function carriedBy(last: LastSwitch): string {
  switch (last.carryOver) {
    case "same-conversation":
      return last.reason ? `${compactionFailureText(last.reason, last.compactedOn ?? last.from.engine)}, so the context was not compacted` : "context compacted in place";
    case "summary": return "carried over by compaction summary";
    case "transcript-pointer": return "the new conversation was told where to read the history";
    case "manual-handover": return `${compactionFailureText(last.reason, last.compactedOn ?? last.from.engine)}, so the new conversation was told where to read the history`;
  }
}

/** The notice text for any `lastSwitch` shape. */
export function switchNoticeText(config: HundredfoldConfig | undefined, last: LastSwitch): string {
  const from = describeSwitchTarget(config, last.from);
  const to = describeSwitchTarget(config, last.to);
  if (!last.applied) {
    return `🔀 Switch to ${to} did not happen: ${last.reason ?? "it was no longer possible"}. Still on ${from}.`;
  }
  // The operator's switch needs no carry-over clause: the pointer is the mechanism, not an outcome to report.
  const detail = last.by === "operator" ? requestedBy(last.by) : `${requestedBy(last.by)}; ${carriedBy(last)}`;
  return `🔀 Switched from ${from} to ${to} (${detail})`;
}

/** Insert the notice into the transcript and announce it live. */
export function recordSwitchNotice(sessionId: string, emit: GatewayEmit, config: HundredfoldConfig | undefined, last: LastSwitch): void {
  const text = switchNoticeText(config, last);
  const meta = { sessionSwitch: last as unknown as JsonObject } as JsonObject;
  const messageId = insertMessage(sessionId, "notification", text, undefined, undefined, undefined, meta);
  try {
    emit("session:notification", { sessionId, message: text, meta, messageId });
  } catch (err) {
    logger.warn(`Failed to emit switch notice for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
