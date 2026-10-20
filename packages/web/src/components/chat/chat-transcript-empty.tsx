import type { ReactNode } from 'react'

/**
 * Sits over the transcript's scroll owner rather than replacing it, so the node
 * the first message lands in is the same node that was on screen before the
 * send. Replacing it is what made the first message blank the chat.
 *
 * It scrolls, and centres through the inner column rather than the overlay
 * itself: a centring flex box that is shorter than its content overflows above
 * and below at once, and the part above the top edge can never be scrolled to.
 * That cut the employee picker's first rows off on a short viewport (a phone
 * with its keyboard up, or turned on its side). The top padding keeps the
 * content out from under the floating header.
 */
export function TranscriptEmptyState({ children }: { children?: ReactNode }) {
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain pt-[var(--chat-header-band)] pb-[calc(var(--space-4)_+_var(--composer-overlap,0px))]">
      <div className="flex min-h-full flex-col items-center justify-center">
        {children ?? (
          <div className="text-center">
            <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">Start a conversation</div>
            <div className="text-[length:var(--text-footnote)] text-[var(--text-quaternary)] mt-[var(--space-2)]">Send a message or use /new to begin</div>
          </div>
        )}
      </div>
    </div>
  )
}
