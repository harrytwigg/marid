import { classifyEngineFailureText, hasEngineFailureClass } from "../shared/engine-failure.js";
import { UNSTATED_RESET_WINDOW_MS } from "../shared/engine-health.js";
import type { FallbackHop, FallbackHopReason, FallbackSkipReason } from "../shared/fallback-chain-wire.js";
import { isModelAvailabilityError } from "../shared/model-fallback.js";
import { computeNextRetryDelayMs } from "../shared/rateLimit.js";
import type { EngineResult } from "../shared/types.js";
import { formatResumeTime } from "./turn/text.js";

/**
 * What a hop is made of and how it reads: the record kept on the session, the
 * line the gateway logs and the notice the transcript and connectors show.
 * Pure: nothing here touches a session.
 */

/** The target on one side of a hop, as the record names it. */
export interface HopEnd {
  key: string;
  label: string;
}

/** Why a target could not serve the turn, as the walk reads it from a result. */
export interface LinkFailure {
  reason: FallbackHopReason;
  /** Unix seconds, when the failure stated a reset. */
  resetsAt?: number;
  /** Whether the failure is a limit that engine health should hold against the target. */
  isLimit: boolean;
}

const RETRY_ABANDONED_RE = /would not retry it for/i;

/** The hop reason of a usage limit: quota for an allowance window, the engine giving up its own retries for that, else a rate limit. */
export function limitReason(result: Pick<EngineResult, "error">): FallbackHopReason {
  const error = result.error ?? "";
  if (RETRY_ABANDONED_RE.test(error)) return "retry-exhausted";
  const classification = classifyEngineFailureText(error);
  return hasEngineFailureClass(classification, "quota") && !hasEngineFailureClass(classification, "rate-limit") ? "quota" : "rate-limit";
}

/** Whether the engine refused the model id it was handed: the failure of a link that does not serve its model. */
export function isInvalidModelFailure(error: string | null | undefined): boolean {
  return hasEngineFailureClass(classifyEngineFailureText(error), "invalid-model") || isModelAvailabilityError(error);
}

export interface BuiltHop {
  at: Date;
  from: HopEnd;
  to: HopEnd | null;
  reason: FallbackHopReason;
  resetsAt?: number;
  skipped: Array<{ key: string; reason: FallbackSkipReason }>;
}

export function buildHop(hop: BuiltHop): FallbackHop {
  return {
    at: hop.at.toISOString(),
    from: hop.from.key,
    to: hop.to?.key ?? null,
    fromLabel: hop.from.label,
    toLabel: hop.to?.label ?? null,
    reason: hop.reason,
    ...(hop.resetsAt === undefined ? {} : { resetsAt: new Date(hop.resetsAt * 1000).toISOString() }),
    ...(hop.skipped.length > 0 ? { skipped: hop.skipped } : {}),
  };
}

/** The one info line a hop logs: who, where to, why, and what was passed over. */
export function hopLogLine(sessionId: string, hop: FallbackHop): string {
  const skipped = hop.skipped?.length ? `; skipped ${hop.skipped.map((entry) => `${entry.key} (${entry.reason})`).join(", ")}` : "";
  return `Session ${sessionId}: fallback hop ${hop.fromLabel} -> ${hop.toLabel ?? "(chain exhausted)"} (${hop.reason})${skipped}`;
}

const WHY: Record<FallbackHopReason, string> = {
  "rate-limit": "hit its usage limit",
  quota: "hit its usage limit",
  "retry-exhausted": "hit its usage limit",
  "invalid-model": "does not serve this model",
  auth: "is signed out",
};

/** The notice text for a hop that moved on, e.g. "⚠️ claude · work · opus hit its usage limit (resets Mon, 19 Oct, 16:00). Moving to claude · spare · sonnet." */
export function hopNoticeText(hop: FallbackHop): string {
  const reset = hop.resetsAt ? formatResumeTime(new Date(hop.resetsAt)) : null;
  const when = reset && hop.reason !== "invalid-model" && hop.reason !== "auth" ? ` (resets ${reset})` : "";
  return `⚠️ ${hop.fromLabel} ${WHY[hop.reason]}${when}. Moving to ${hop.toLabel}.`;
}

/** What a run that ran out of chain says about itself: the targets it tried, named. */
export function chainExhaustedReason(triedLabels: readonly string[], ownLabel: string): string {
  return `every target in its fallback chain was tried (${triedLabels.join(", ")}); waiting for ${ownLabel} to reset`;
}

/** The own target's reset as a notice says it: "at <time>", or "(time unknown)" when none is known. */
function resetClause(resumeAt: Date | null | undefined): string {
  const when = formatResumeTime(resumeAt);
  return when ? `at ${when}` : "(time unknown)";
}

/** The notice for a run that ran out of chain: plainly that no hop is left, what was tried, and what the session waits for. */
export function chainExhaustedNotice(exhausted: { tried: readonly string[]; own: string }, resumeAt: Date | null | undefined): string {
  return `⏳ Every target in this session's chain is at its limit (tried: ${exhausted.tried.join(", ")}). Waiting for ${exhausted.own} to reset ${resetClause(resumeAt)}.`;
}

/** The session's `lastError` while it waits on its own target after the chain ran out. */
export function chainExhaustedLastError(ownLabel: string, resumeAt: Date | null | undefined): string {
  const when = formatResumeTime(resumeAt);
  return `${ownLabel} usage limit, ${when ? `resumes ${when}` : "reset time unknown"}`;
}

/** The window a hop's stand-in holds the session for: until the failing target's stated reset, else a default window. */
export function windowOf(resetsAt: number | undefined): { resumeAt: Date | undefined; until: Date } {
  const { resumeAt } = computeNextRetryDelayMs(resetsAt);
  return { resumeAt, until: resumeAt ?? new Date(Date.now() + UNSTATED_RESET_WINDOW_MS) };
}
