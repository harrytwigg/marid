import { X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/**
 * Close every tab, at the end of a tab bar: a boxed × so it reads as one action on the whole set
 * rather than one more per-tab close, and icon-only so the bar keeps its height — its name is the
 * label and the hover tooltip. `self-center` is deliberate: the strips lay their children out
 * stretched, which would otherwise pin a fixed-size button to the top of the bar.
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
        'grid shrink-0 self-center place-items-center rounded-[var(--radius-sm)] border border-[var(--glass-edge)] bg-[var(--fill-tertiary)] text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--accent)]',
        compact ? 'size-8' : 'size-6',
      )}
    >
      <X size={compact ? 14 : 12} aria-hidden />
    </button>
  )
}
