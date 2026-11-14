/**
 * Says so when a conversation could not be fetched, instead of leaving a blank
 * transcript that reads as "this chat has no history". It sits above the
 * transcript (not in its footer, which turns off virtualization) and goes away
 * the moment a load succeeds. The hook retries by itself; the button only
 * brings the next attempt forward.
 */
export function SessionLoadNotice({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-testid="session-load-notice"
      className="flex shrink-0 items-center justify-center gap-3 px-[var(--space-4)] py-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)]"
    >
      <span>
        {retrying
          ? "Couldn't load this conversation. The history is still saved; retrying."
          : "Couldn't load this conversation."}
      </span>
      <button type="button" onClick={onRetry} className="underline underline-offset-2 text-[var(--text-primary)]">
        Retry now
      </button>
    </div>
  )
}
