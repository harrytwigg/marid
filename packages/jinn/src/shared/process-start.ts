/** The last thing a PTY printed, as one plain line: escape sequences and
 *  control characters removed, whitespace collapsed, at most `max` characters
 *  from the end. */
export function plainOutputTail(output: string, max = 300): string {
  const plain = output
    // CSI and OSC sequences (colours, cursor moves, titles), then any other escape.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= max ? plain : `…${plain.slice(-max)}`;
}

/**
 * Why a turn failed when its PTY's process went away before the engine reported
 * that its session had started — so it never ran the turn at all.
 *
 * Deliberately NOT prefixed `Interrupted`: nobody stopped this turn, the
 * process could not start (an `execvp` refusal such as "Argument list too
 * long" or "No such file or directory", an unknown CLI flag, a crash on boot).
 * Read as an interruption, `wasQuietlyPreempted` (sessions/turn/runner.ts)
 * would settle it silently and drop the reason. node-pty forks before it execs, so a refused exec never
 * throws at spawn: the child prints the reason into the PTY and exits 1, which
 * is why the process's own last output is carried here.
 */
export function processStartFailure(engine: string, exit?: { exitCode?: number | null; signal?: number | null }, output?: string): string {
  const said = output ? plainOutputTail(output) : "";
  return `${engine} did not start: its process exited (code ${exit?.exitCode ?? "unknown"}, signal ${exit?.signal ?? "unknown"}) `
    + `before its session began${said ? `. Its last output: ${said}` : ", with no output"}`;
}

/** Whether an engine error is a {@link processStartFailure}. */
export function isProcessStartFailure(error: string): boolean {
  return /^\S+ did not start: its process exited\b/.test(error);
}

/** How codex says the thread it was asked to resume has no rollout on disk. */
export const CODEX_MISSING_ROLLOUT = /no rollout found|code -32600|thread\/resume failed/i;

/** What each CLI prints when the conversation it was asked to resume is gone. */
const MISSING_CONVERSATION: readonly RegExp[] = [
  /no conversation found/i, // Claude Code
  CODEX_MISSING_ROLLOUT,
  /unknown session id|session not found|no session found/i, // grok
];

/** Whether CLI output says the conversation it was asked to resume no longer exists. */
export function isMissingConversationOutput(text: string): boolean {
  return MISSING_CONVERSATION.some((pattern) => pattern.test(text));
}
