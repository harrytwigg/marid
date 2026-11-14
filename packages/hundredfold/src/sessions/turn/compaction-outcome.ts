import { findSessionTranscript } from "../../engines/claude-transcript-path.js";
import type { EngineResult } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { awaitSummaryFromTranscript, SUMMARY_MAX_CHARS } from "../compaction-summary.js";
import {
  awaitsCompactionOutcome, recordCompactionOutcome, type CompactionFailure, type CompactionOutcome, type CompactionTurn, type PendingSwitch,
} from "../pending-switch.js";
import { sessionClaudeProfile } from "../session-account.js";
import { transcriptCwd } from "../session-cwd.js";
import type { TurnRun } from "./types.js";

/**
 * Telling a pending switch how its compaction turn ended (plan D6). Each settle path that a
 * `/compact` can end on calls in with what it knows; a path that does not (a quiet pre-emption, a
 * preflight refusal, a restart cut-off) records nothing, and the resume reads that as `no-outcome`.
 * Only the compaction a session's own switch queued records: the pending switch decides, by the
 * focus line and the claim time, so an operator's `/compact` never lands on it.
 */

function turnOf(run: TurnRun): CompactionTurn {
  return { sessionId: run.input.session.id, prompt: run.input.prompt, startedAt: run.turnStartedAt };
}

/** The compaction ended without a summary for this reason. */
export function recordCompactionFailure(run: TurnRun, reason: CompactionFailure): void {
  if (!run.plan.compaction) return;
  recordCompactionOutcome(turnOf(run), { ok: false, reason });
}

/** Claude's summary, from the transcript of the conversation this turn compacted, on the profile it ran on. */
async function claudeSummary(run: TurnRun, result: EngineResult): Promise<string | undefined> {
  const id = result.sessionId?.trim() || run.plan.resumeNativeId;
  if (!id) return undefined;
  const profile = sessionClaudeProfile(run.input.session, run.input.employee);
  const transcript = findSessionTranscript(id, profile ?? undefined, transcriptCwd(run.input.session));
  return transcript ? await awaitSummaryFromTranscript(transcript, run.turnStartedAt) : undefined;
}

async function summaryOf(run: TurnRun, result: EngineResult): Promise<string | undefined> {
  if (run.plan.engineName === "claude") return await claudeSummary(run, result);
  return run.plan.engineName === "opencode" ? result.compactionSummary : undefined;
}

/** A confirmed compaction's outcome: in place needs no summary; a new conversation opens on it, or on the reason it has none. */
async function confirmedOutcome(run: TurnRun, result: EngineResult, pending: PendingSwitch): Promise<CompactionOutcome> {
  if (pending.conversation === "same") return { ok: true, summary: "" };
  let summary: string | undefined;
  try {
    summary = (await summaryOf(run, result))?.trim();
  } catch (err) {
    logger.warn(`[self-compaction] ${run.input.session.id}: could not read the compaction summary: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!summary) return { ok: false, reason: "no-summary" };
  return summary.length > SUMMARY_MAX_CHARS ? { ok: false, reason: "summary-too-long" } : { ok: true, summary };
}

/** The compaction turn the engine answered: confirmed, unconfirmed or errored. */
export async function recordAnsweredCompaction(run: TurnRun, result: EngineResult): Promise<void> {
  if (!run.plan.compaction) return;
  const pending = awaitsCompactionOutcome(turnOf(run));
  if (!pending) return;
  const outcome: CompactionOutcome = result.error
    ? { ok: false, reason: "error" }
    : (result.compaction ? await confirmedOutcome(run, result, pending) : { ok: false, reason: "unconfirmed" });
  recordCompactionOutcome(turnOf(run), outcome);
}
