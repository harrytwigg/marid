import type { JinnConfig } from "../../shared/types.js";

/**
 * The Todo board procedure, re-sent at the end of every turn's prompt. The
 * rules live in the system prompt and the todo-handling skill, but a long or
 * compacted conversation stops attending to them, and a session woken by a
 * comment or a message is the one most likely to work feedback on an
 * `in_review` Todo without moving it, or to leave a Todo that needs a person in
 * `executing`. One fixed paragraph: at most 120 o200k_base tokens with its label, pinned by
 * board-reminder.test.ts. Each turn's copy stays in the engine's history, so a
 * conversation of N turns holds N of them until it is compacted.
 */
export const DEFAULT_BOARD_REMINDER =
  "Todo board: check status with get_work_item before changing it. "
  + "`executing` means you are working the Todo right now (feedback on in_review too). "
  + "NEVER end a turn, or wait on a person or dependency, with the Todo in `executing`. "
  + "Waiting, or ending your turn with a question or decision for the operator: first move it to `blocked`, "
  + "keep the assignee, note who, what and your recommendation, and @mention the operator for a decision. "
  + "Unblocked: executing. "
  + "Finished: in_review + note.";

/**
 * The same paragraph for a session whose own child Todos, delegations or
 * reviewer sessions are still running. It stays `executing` and ends its turn:
 * each result wakes it, and a block would re-queue the Todo and, repeated, send
 * it to the operator over a wait nobody outside its delegation tree is part of.
 * Same token budget as the default.
 */
export const PARENT_WAITING_BOARD_REMINDER =
  "Todo board: check status with get_work_item before changing it. "
  + "`executing` means you are working the Todo right now (feedback on in_review too). "
  + "Your own child Todos, delegations or QA are still running: leave the Todo `executing` and end your turn; results wake you. "
  + "Waiting on someone outside your delegation tree, or a decision for the operator: first move it to `blocked`, "
  + "keep the assignee, note who, what and your recommendation, and @mention the operator for a decision. "
  + "Finished: in_review + note.";

/** In an instance's `context.boardReminder`, replaced by the built-in text so an instance can extend it. */
export const BOARD_REMINDER_DEFAULT_TOKEN = "{{default}}";

/** What marks the line as the gateway's, not the sender's. */
export const BOARD_REMINDER_LABEL = "[Gateway reminder]";

/**
 * The reminder this session's turns carry, or undefined when they carry none: a
 * session without the built-in jinn MCP server has no Todo tools to apply it
 * with, and an instance may turn it off with `context.boardReminder: false` (or "").
 * `waitingOnOwnWork` swaps the built-in text for the one that keeps the Todo
 * `executing`; an instance's own text is sent as written.
 */
export function resolveBoardReminder(
  config: Pick<JinnConfig, "context">,
  jinnMcpAttached: boolean,
  waitingOnOwnWork = false,
): string | undefined {
  if (!jinnMcpAttached) return undefined;
  const configured = config.context?.boardReminder;
  const builtIn = waitingOnOwnWork ? PARENT_WAITING_BOARD_REMINDER : DEFAULT_BOARD_REMINDER;
  if (configured === false) return undefined;
  const text = typeof configured === "string"
    ? configured.split(BOARD_REMINDER_DEFAULT_TOKEN).join(builtIn)
    : builtIn;
  return text.trim() || undefined;
}

/**
 * The prompt as the engine receives it. Applied when the engine is called, never
 * to the stored message, so the session's messages keep only what the sender
 * wrote. A slash command is left alone: whether the engine runs it (/compact,
 * /init) or reads it as a skill, text after it becomes its arguments, and a
 * newline in one pasted into Claude's composer submits it early.
 */
export function withBoardReminder(prompt: string, reminder: string | undefined): string {
  if (!reminder || prompt.trimStart().startsWith("/")) return prompt;
  const line = `${BOARD_REMINDER_LABEL} ${reminder}`;
  return prompt.trim() ? `${prompt}\n\n${line}` : line;
}

/**
 * A prompt read back from an engine's own transcript, without the reminder this
 * gateway appended to it, so a transcript sync cannot write it into the
 * session's stored message.
 */
export function withoutBoardReminder(text: string): string {
  const at = text.lastIndexOf(`${BOARD_REMINDER_LABEL} `);
  if (at === -1) return text;
  const before = text.slice(0, at);
  if (before.trim() && !/\n[ \t]*\n[ \t]*$/.test(before)) return text;
  return before.trimEnd();
}
