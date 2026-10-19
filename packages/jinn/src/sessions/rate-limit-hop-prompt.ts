import { getMessages } from "./registry.js";
import { syncTranscriptPrompt } from "./turn/sync-transcript.js";

/**
 * The prompt a fallback chain hop sends, by what the target already has.
 *
 * - A thread of its own (same engine and account, or one a run used before):
 *   resumed, and told what it missed since it last answered (`since`, its slot's
 *   `lastSyncedAt`). Nothing missed, nothing added: the prompt as it is.
 * - No thread: a fresh conversation handed the session so far.
 */

const HANDOFF_MESSAGES = 12;
const RESUMED_INTRO = "This session moved between engines or accounts after usage limits, so this conversation missed some of what was said. "
  + "Sync your context with this transcript (most recent last), then respond to the current message.";

/** The recent conversation for an engine with no thread of its own to resume: the last twelve messages. */
export function handoffPrompt(sessionId: string): string {
  const history = getMessages(sessionId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`);
  return `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${history.slice(-HANDOFF_MESSAGES).join("\n\n")}`;
}

/** Whether `message` is the user message `prompt` answers (the prompt may carry text added after it, such as the board reminder). */
function isCurrentMessage(message: { role: string; content: string }, prompt: string): boolean {
  return message.role === "user" && prompt.trimStart().startsWith(message.content.trim());
}

/** The prompt for a resumed thread: the transcript it missed since `since`, then the prompt; the prompt itself when it missed nothing. */
export function resumedPrompt(sessionId: string, since: string | undefined, prompt: string): string {
  const sinceMs = Date.parse(since ?? "");
  if (!Number.isFinite(sinceMs)) return prompt;
  const missed = getMessages(sessionId).filter((message) => message.timestamp >= sinceMs && (message.role === "user" || message.role === "assistant"));
  const latest = missed.at(-1);
  const earlier = latest && isCurrentMessage(latest, prompt) ? missed.slice(0, -1) : missed;
  return earlier.length === 0 ? prompt : syncTranscriptPrompt({ recentMessages: earlier, prompt, intro: RESUMED_INTRO });
}
