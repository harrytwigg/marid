import type { HundredfoldConfig } from "../shared/types.js";
import { handoffSections, type CompactionHandoff } from "./self-compaction.js";
import { compactionFailureText } from "./switch-notice.js";
import { describeSwitchTarget, type SwitchTargetView } from "./switch-target.js";
import { POINTER_READ_LAST } from "./turn/history-pointer.js";

/**
 * The resume turn's message once a session's own switch is decided (contracts §4): where it
 * now runs, how the earlier conversation reaches it, then the handoff verbatim. Earlier
 * message text is never pasted here: a new conversation gets the compaction's summary when
 * there is one, and otherwise a pointer to where the history can be read.
 */

export type ResumeCarryOver =
  | { kind: "same-conversation"; failure?: string }
  | { kind: "summary"; summary: string }
  | { kind: "manual-handover"; failure: string }
  | { kind: "not-applied"; reason: string; compacted: boolean };

export interface SwitchResumeInput {
  config: HundredfoldConfig;
  sessionId: string;
  /** The target the session now runs on, or (not applied) the one it asked for. */
  target: SwitchTargetView;
  /** Where the session stays when the switch did not happen. */
  current: SwitchTargetView;
  /** The engine the left conversation ran on, for the failure wording. */
  fromEngine: string;
  handoff: CompactionHandoff;
  carry: ResumeCarryOver;
  /** The left Claude conversation's transcript path (unscoped sessions only). */
  leftTranscript?: string;
}

function carryLine(input: SwitchResumeInput): string {
  const { carry, config, sessionId, leftTranscript } = input;
  switch (carry.kind) {
    case "same-conversation":
      return carry.failure
        ? `Your context could not be compacted (${compactionFailureText(carry.failure, input.fromEngine)}); the conversation carries on as it was.`
        : "Your context was compacted in place.";
    case "summary":
      return "This is a new conversation. The summary of the previous one follows, then your handoff.";
    case "manual-handover":
      return "This is a new conversation and the previous one could not be summarised "
        + `(${compactionFailureText(carry.failure, input.fromEngine)}). Your earlier history is not repeated here: read it with read_session `
        + `{sessionId: "${sessionId}", last: ${POINTER_READ_LAST}}${leftTranscript ? ` and ${leftTranscript}` : ""} before resuming.`;
    case "not-applied":
      return `The switch to ${describeSwitchTarget(config, input.target)} did not happen (${carry.reason}); you are still on ${describeSwitchTarget(config, input.current)}. `
        + `Your context was ${carry.compacted ? "compacted" : "not compacted"}.`;
  }
}

/** The earlier-detail pointer that follows a summary. */
function earlierDetail(input: SwitchResumeInput): string {
  return `Earlier detail: read_session {sessionId: "${input.sessionId}"}${input.leftTranscript ? ` or ${input.leftTranscript}` : ""}.`;
}

/** The resume message a session's own switch delivers in place of the payload it was queued with. */
export function switchResumePrompt(input: SwitchResumeInput): string {
  const runsOn = input.carry.kind === "not-applied" ? input.current : input.target;
  const head = `[Session switch resume] You asked to move this session (compact_session). It now runs on ${describeSwitchTarget(input.config, runsOn)}. ${carryLine(input)}`
    + " The handoff below is exact where any summary is lossy. Resume the work now from \"Next\": do not wait for another message, and do not compact again straight away.";
  const summary = input.carry.kind === "summary" ? [`## Summary of the previous conversation\n${input.carry.summary}`, earlierDetail(input)] : [];
  return [head, ...summary, ...handoffSections(input.handoff)].join("\n\n");
}
