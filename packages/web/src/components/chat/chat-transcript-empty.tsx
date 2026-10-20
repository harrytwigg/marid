import type { ReactNode } from 'react'

/**
 * Sits over the transcript's scroll owner rather than replacing it, so the node
 * the first message lands in is the same node that was on screen before the
 * send. Replacing it is what made the first message blank the chat.
 */
export function TranscriptEmptyState({ children }: { children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {children ?? (
        <div className="text-center">
          <div className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">Start a conversation</div>
          <div className="text-[length:var(--text-footnote)] text-[var(--text-quaternary)] mt-[var(--space-2)]">Send a message or use /new to begin</div>
        </div>
      )}
    </div>
  )
}

/**
 * A frame for an empty state that can be taller than the pane (the new chat's employee picker), placed
 * inside `TranscriptEmptyState`. It scrolls, and centres through an inner column rather than itself: a
 * centring flex box that is shorter than its content overflows above its top edge as well as below, and
 * the part above can never be scrolled to. That cut the picker's first rows off on a short viewport (a
 * phone with its keyboard up, or turned on its side). The top padding keeps the content out from under
 * the floating header.
 *
 * Only for content that sizes itself. The "Open chat" picker fills the overlay with `h-full` and scrolls
 * its own virtualised list, so it must not sit in here: the column has no definite height to fill.
 */
export function ScrollingEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="h-full w-full overflow-y-auto overscroll-contain pt-[var(--chat-header-band)] pb-[calc(var(--space-4)_+_var(--composer-overlap,0px))]">
      <div className="flex min-h-full flex-col items-center justify-center">{children}</div>
    </div>
  )
}
