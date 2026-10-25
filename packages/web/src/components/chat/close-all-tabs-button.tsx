import { X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/**
 * "Close all" as the tab bars carry it: a labelled button at the end of the tabs, standing where
 * they are rather than buried in the overflow menu. `compact` is the phone's 44px strip; the
 * desktop bars take the tighter size.
 */
export function CloseAllTabsButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      data-pane-focus-preserving
      data-close-all-tabs
      aria-label="Close all tabs"
      title="Close all tabs"
      onClick={(event) => { event.stopPropagation(); onClick() }}
      onMouseDown={(event) => event.stopPropagation()}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]',
        compact ? 'h-9 px-2' : 'h-6 px-1.5',
      )}
    >
      <X size={compact ? 12 : 11} aria-hidden />
      <span>Close all</span>
    </button>
  )
}
