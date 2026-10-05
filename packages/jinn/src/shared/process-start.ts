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

/** What each CLI prints when the conversation `id` it was asked to resume is gone. */
function missingConversation(id: string): RegExp[] {
  const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = "(?![\\w-])";
  return [
    // Claude Code: "No conversation found with session ID: <id>"
    new RegExp(`no conversation found with session id:?\\s*${quoted}${end}`, "i"),
    // codex's TUI (`codex resume <id>`, codex-rs/tui/src/lib.rs):
    // "No saved session found with ID <id>. Run `codex resume` without an ID ..."
    new RegExp(`no saved session found with id\\s+${quoted}${end}`, "i"),
  ];
}

/**
 * Whether CLI output says the conversation it was asked to resume, `id`, no
 * longer exists. The id must be in the sentence: what is cleared on a match is
 * that conversation, and a resumed TUI can replay earlier messages, phrase and
 * all, before it dies. grok has no verified wording, so it is never matched.
 */
export function isMissingConversationOutput(text: string, id: string | undefined): boolean {
  if (!id) return false;
  return missingConversation(id).some((pattern) => pattern.test(text));
}
