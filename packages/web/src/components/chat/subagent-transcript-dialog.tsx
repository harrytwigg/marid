import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import SubagentChatView from '@/components/chat/subagent-chat-view'
import type { SubagentRef } from '@/lib/subagent-transcript'

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()
/** A dialog's events travel through React's tree to the chat pane it was opened from, whose click, key,
 *  focus-tracking and file-drop handlers have no business with a read-only view. A drop is also
 *  cancelled here, or the browser would open the file in place of the page. */
const ISOLATED = {
  onClick: stop,
  onPointerDown: stop,
  onMouseDown: stop,
  onKeyDown: stop,
  onDragEnter: stop,
  onDragLeave: stop,
  onDragOver: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation() },
  onDrop: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation() },
}

/**
 * A background sub-agent's conversation in a sheet over the chat, for where the layout has no tab to
 * put it in (a phone): the whole screen there. It is a dialog, not a route, so closing it leaves the
 * chat exactly as it was.
 */
export default function SubagentTranscriptDialog({ sessionId, agent, returnFocusTo = null, onClose }: {
  sessionId: string
  agent: SubagentRef
  /** Takes focus when the view closes, if it is still on the page. */
  returnFocusTo?: HTMLElement | null
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        data-testid="subagent-transcript-dialog"
        data-pane-focus-preserving
        {...ISOLATED}
        onCloseAutoFocus={(event) => {
          // Radix would return focus to the popup row that opened this, which is gone.
          if (!returnFocusTo?.isConnected) return
          event.preventDefault()
          returnFocusTo.focus()
        }}
        className="flex h-[min(80vh,720px)] w-[min(720px,calc(100vw-16px))] max-w-none flex-col gap-0 overflow-hidden rounded-[var(--radius-xl)] border-0 bg-[var(--bg)] p-0 shadow-[var(--shadow-overlay)] max-sm:h-dvh max-sm:w-screen max-sm:rounded-none sm:max-w-none"
      >
        <DialogTitle className="sr-only">{agent.description ?? 'Sub-agent'}</DialogTitle>
        <DialogDescription className="sr-only">A background sub-agent&apos;s conversation, read-only.</DialogDescription>
        <SubagentChatView sessionId={sessionId} agent={agent} padRight />
      </DialogContent>
    </Dialog>
  )
}
