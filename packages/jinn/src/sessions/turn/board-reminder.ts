import type { JinnConfig } from "../../shared/types.js";

/**
 * The Todo board procedure, re-sent at the end of every turn's prompt. The
 * rules live in the system prompt and the todo-handling skill, but a long or
 * compacted conversation stops attending to them, and a session woken by a
 * comment or a message is the one most likely to work feedback on an
 * `in_review` Todo without moving it, or to leave a Todo that needs a person in
 * `executing`. One fixed line on every turn is cheap enough to always carry:
 * 59 o200k_base tokens with its label, pinned by board-reminder.test.ts.
 */
export const DEFAULT_BOARD_REMINDER =
  "Todo board: check status with get_work_item before changing it. "
  + "Working on it (feedback on in_review too): executing. "
  + "Waiting on a person: blocked + note (who, what). "
  + "Unblocked: executing. "
  + "Finished: in_review + note. Only the operator closes.";

/** In an instance's `context.boardReminder`, replaced by the built-in text so an instance can extend it. */
export const BOARD_REMINDER_DEFAULT_TOKEN = "{{default}}";

/** What marks the line as the gateway's, not the sender's. */
export const BOARD_REMINDER_LABEL = "[Gateway reminder]";

/**
 * The reminder this turn carries, or undefined when it carries none: an
 * engine-native command must reach the engine exactly as written, a session
 * without the built-in jinn MCP server has no Todo tools to apply it with, and
 * an instance may turn it off with `context.boardReminder: false` (or "").
 */
export function resolveBoardReminder(
  config: Pick<JinnConfig, "context">,
  opts: { jinnMcpAttached: boolean; rawCommand: boolean },
): string | undefined {
  if (opts.rawCommand || !opts.jinnMcpAttached) return undefined;
  const configured = config.context?.boardReminder;
  if (configured === false) return undefined;
  const text = typeof configured === "string"
    ? configured.split(BOARD_REMINDER_DEFAULT_TOKEN).join(DEFAULT_BOARD_REMINDER)
    : DEFAULT_BOARD_REMINDER;
  return text.trim() || undefined;
}

/**
 * The prompt as the engine receives it. Applied when the engine is called, never
 * to the stored message, so the transcript keeps only what the sender wrote.
 */
export function withBoardReminder(prompt: string, reminder: string | undefined): string {
  if (!reminder) return prompt;
  const line = `${BOARD_REMINDER_LABEL} ${reminder}`;
  return prompt.trim() ? `${prompt}\n\n${line}` : line;
}
