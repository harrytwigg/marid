import { X } from '@/components/ui/icon'
import { cn } from '@/lib/utils'

/**
 * Close every tab, at the end of a tab bar. The glyph is two ×s set diagonally — the larger one in
 * front, a smaller one showing behind its top-right corner — so it reads as one action on the whole
 * set rather than one more per-tab close. The one behind is drawn first and dimmed, which is what
 * puts it behind rather than beside. The canvas is 18px (22px for the phone) because the two arms
 * run along the same diagonal: any tighter and they merge into one long stroke at 24px. It is
 * icon-only to keep the bar's height, so its name comes from the label and the hover tooltip.
 * `self-center` is deliberate: the strips lay their children out stretched, which would otherwise
 * pin a fixed-size button to the top of the bar.
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
      <span aria-hidden className={cn('relative block', compact ? 'size-[22px]' : 'size-[18px]')}>
        {/* Drawn first, and dimmed, so the larger one reads as being in front of it. */}
        <X size={compact ? 11 : 9} className="absolute right-0 top-0 opacity-55" />
        <X size={compact ? 15 : 12} className="absolute bottom-0 left-0" />
      </span>
    </button>
  )
}
