import type { ReactNode } from "react"
import { Search } from "lucide-react"

/* The cards a board shows instead of columns when it has nothing to draw.
 *
 * An ordinary empty board still celebrates quietly — the columns and their
 * quick-adds ARE its empty state (states mock §6). These two are the boards
 * where silence would read as breakage: one the operator filtered down to
 * nothing, and one that is empty until they fill it themselves. */

function EmptyCard(
  { icon, title, caption, action, testId }:
  {
    icon: ReactNode
    title: string
    caption: string
    action?: { label: string; onClick: () => void; testId: string }
    testId: string
  },
) {
  return (
    <div className="flex justify-center px-6 pb-10 pt-14" data-testid={testId}>
      <div className="flex w-[330px] flex-col items-center rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[36px_24px] text-center shadow-[var(--shadow-card)]">
        <div
          className="grid size-16 place-items-center rounded-[22px] bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]"
          style={{ boxShadow: "var(--inset-shine)" }}
          aria-hidden
        >
          {icon}
        </div>
        <div className="mt-4 text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">{title}</div>
        <p className="mt-1.5 text-[14px] leading-[1.5] text-[var(--text-tertiary)]">{caption}</p>
        {action && (
          <button
            type="button"
            data-testid={action.testId}
            onClick={action.onClick}
            className="focus-ring mt-3 rounded-full px-2.5 py-1 text-[13px] font-semibold text-[var(--accent)] outline-none hover:bg-[var(--accent-fill)]"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}

/** Filtered-empty always offers the way back (states mock §6). */
export function FilteredEmptyCard({
  count,
  onClear,
  testId = "board-filtered-empty",
  clearTestId = "board-clear-filters",
}: {
  count: number
  onClear: () => void
  testId?: string
  clearTestId?: string
}) {
  const caption =
    count === 1 ? "One filter is set on this board."
    : count === 2 ? "Two filters are set on this board."
    : `${count} filters are set on this board.`
  return (
    <EmptyCard
      icon={<Search size={24} strokeWidth={2} />}
      title="No todos match."
      caption={caption}
      action={{ label: "Clear filters", onClick: onClear, testId: clearTestId }}
      testId={testId}
    />
  )
}
