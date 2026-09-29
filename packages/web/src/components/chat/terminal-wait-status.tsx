/**
 * Composer status line for a message that is WAITING, not running: the session
 * is claude, the operator typed a turn straight into the CLI terminal, and the
 * gateway holds this message until that turn finishes. Without this,
 * a message that produces nothing reads as a hang. It says what is happening
 * and offers the way out: Stop cancels the waiting message; the turn in the
 * terminal keeps running.
 */
export function TerminalWaitStatus({ onStop }: { onStop: () => void }) {
  return (
    <span
      role="status"
      data-testid="terminal-wait-status"
      title="Your message runs after the turn you typed in the terminal finishes. Stop cancels this message; the terminal turn keeps running."
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--system-blue)]" />
      <span className="hidden min-w-0 truncate sm:inline">Waiting for the turn typed in the terminal</span>
      <span className="min-w-0 truncate sm:hidden">Waiting on terminal</span>
      <button
        type="button"
        onClick={onStop}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[var(--accent)] transition-colors hover:bg-[var(--fill-tertiary)]"
      >
        Stop
      </button>
    </span>
  )
}
