import type { Session } from "../../shared/types.js";
import { sessionScopeDepartment } from "../session-scope.js";

/**
 * The prompt for the first turn after a deliberate switch of engine or Claude profile
 * (`switchSessionTarget`): the new conversation starts empty, so it is told where the
 * history can be read instead of being handed it. Earlier message text is never pasted
 * here; that is the transcript catch-up other writers owe, which stays as it was.
 */

/** How many recent messages the pointer asks `read_session` for; more can be asked for, up to {@link POINTER_READ_MAX}. */
export const POINTER_READ_LAST = 100;
export const POINTER_READ_MAX = 500;

/** The left Claude conversation's transcript path recorded on `lastSwitch`, for a session whose files the caller may read. */
function leftTranscriptOf(session: Session): string | undefined {
  // A department-scoped session reads through the tool only: a file path outside its stage is not its to open.
  if (sessionScopeDepartment(session)) return undefined;
  const last = session.transportMeta?.lastSwitch;
  const path = last && typeof last === "object" && !Array.isArray(last) ? (last as Record<string, unknown>).leftTranscript : undefined;
  return typeof path === "string" && path.trim() ? path : undefined;
}

export function historyPointerPrompt(session: Session, prompt: string): string {
  const transcript = leftTranscriptOf(session);
  const intro = [
    "This session was switched to another engine or Claude profile, so this conversation starts without the earlier history.",
    "It is not repeated here: before you rely on it, read it with read_session",
    `{sessionId: "${session.id}", last: ${POINTER_READ_LAST}} (up to ${POINTER_READ_MAX} for more)`
      + `${transcript ? `, or open the previous conversation's own transcript at ${transcript}` : ""}.`,
    "Then respond to the current message.",
  ].join(" ");
  return [intro, prompt.trim() ? `CURRENT MESSAGE:\n${prompt}` : ""].filter(Boolean).join("\n\n");
}
