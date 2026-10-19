import type { SessionMessage } from "../message-row.js";

/**
 * The prompt that brings an engine conversation up to date: a transcript of
 * what it has not seen, then the current message. Shared by the two things that
 * owe a conversation a catch-up: a session that switched engines (`preflight.ts`)
 * and a thread a fallback chain hop resumes after other targets served turns
 * (`rate-limit-hop-prompt.ts`).
 */

/** How many prior messages a synthesized catch-up transcript carries. */
export const SYNC_TRANSCRIPT_MESSAGES = 20;

/**
 * `recentMessages` is what the conversation has not seen, oldest first; `prompt`
 * is the message to answer. The prompt is not repeated when the newest message
 * already is it.
 */
export function syncTranscriptPrompt(opts: { recentMessages: readonly SessionMessage[]; prompt: string; intro: string }): string {
  const { recentMessages, prompt, intro } = opts;
  const transcript = recentMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .slice(-SYNC_TRANSCRIPT_MESSAGES)
    .join("\n\n");

  const latest = recentMessages.at(-1);
  const promptAlreadyInTranscript = latest?.content === prompt
    && (latest.role === "user" || latest.role === "assistant");
  const currentPrompt = promptAlreadyInTranscript || !prompt.trim() ? "" : `CURRENT MESSAGE:\n${prompt}`;
  return [intro, transcript, currentPrompt].filter(Boolean).join("\n\n");
}
