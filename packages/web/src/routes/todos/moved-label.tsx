/** The one line a board member reads on a Todo they created that has left their boards. It says where it is not, never where it went. */
export const MOVED_TO_ANOTHER_BOARD = "Moved to another board"

export function MovedLabel({ testId, className }: { testId: string; className?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex h-5 w-fit max-w-full items-center whitespace-nowrap rounded-[10px] bg-[var(--fill-tertiary)] px-2 text-[calc(11px*var(--text-scale))] font-medium text-[var(--text-secondary)] ${className ?? ""}`}
    >
      {MOVED_TO_ANOTHER_BOARD}
    </span>
  )
}
