/**
 * `context`: what the gateway adds to the prompt an engine is handed. Kept
 * beside `config-types.ts` so the schema can grow without pushing that file
 * past its size budget; the type and its validation live together.
 */
export interface ContextConfig {
  /** Max characters for the built system prompt. Defaults to 100000. */
  maxChars?: number;
  /**
   * Instance-relative files whose contents are injected into every session
   * prompt (e.g. a small current-truth file). Each is capped and marked when
   * cut; a path that escapes the instance home or cannot be read is skipped.
   * Absent or empty adds nothing.
   */
  alwaysInclude?: string[];
  /**
   * The Todo board line appended to every turn's prompt for sessions with
   * the built-in jinn MCP server (sessions/turn/board-reminder.ts). Absent
   * uses the built-in text; a string replaces it, with `{{default}}` standing
   * for the built-in text; `false` or "" turns it off.
   */
  boardReminder?: string | false;
}

/** Problems with the `context` block, for the config loader. */
export function contextConfigProblems(context: unknown): string[] {
  if (context === undefined || context === null) return [];
  if (typeof context !== "object" || Array.isArray(context)) return ["context must be a mapping"];
  const { alwaysInclude, boardReminder } = context as Record<string, unknown>;
  return [...alwaysIncludeProblems(alwaysInclude), ...boardReminderProblems(boardReminder)];
}

function alwaysIncludeProblems(files: unknown): string[] {
  if (files === undefined || (Array.isArray(files) && files.every((f) => typeof f === "string"))) return [];
  return ["context.alwaysInclude must be a list of instance-relative file paths"];
}

function boardReminderProblems(text: unknown): string[] {
  if (text === undefined || text === false || typeof text === "string") return [];
  return [`context.boardReminder must be a string or false (got ${typeof text})`];
}
