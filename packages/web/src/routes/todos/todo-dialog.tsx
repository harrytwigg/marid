import { useCallback, useEffect, useRef } from "react"
import DialogPopup, { type DialogMotion } from "@/components/ui/dialog-popup"
import { cn } from "@/lib/utils"

/** The React Aria modal holds its box mounted until the exit animation ends, then drops the box and everything in
 *  it. The caller may stop rendering the dialog only once nothing is left on screen, and that moment is the
 *  box's unmount: reduced motion leaves no animation to wait out, and React Aria then unmounts at once, so
 *  this never waits for an event that will not fire. An unmount while still open (the page left) is not an exit
 *  and reports nothing. */
function ExitReport({ open, onClosed }: { open: boolean; onClosed: () => void }): null {
  const state = useRef({ open, onClosed })
  useEffect(() => {
    state.current = { open, onClosed }
  })
  useEffect(
    () => () => {
      if (!state.current.open) state.current.onClosed()
    },
    [],
  )
  return null
}

/** Shared focus scope for Todo sheets and creation dialogs. The modal owns focus containment and return, scroll
 * lock, outside presses and Escape dispatch; callers own the dirty-close policy. */
export function TodoDialog({
  open,
  label,
  onRequestClose,
  onClosed,
  children,
  className,
  motion = "sheet-pop",
  testId,
}: {
  /** Flip to false to play the exit. Unmounting instead skips it: the modal reads the close off this prop,
   *  and a node that is already gone has nothing to transition. */
  open: boolean
  label: string
  /** Escape or a press outside asked to leave. The caller decides whether that is granted — a dirty draft
   *  answers with a confirmation. */
  onRequestClose: () => void
  /** The exit is over and nothing of the dialog is left in the DOM. */
  onClosed: () => void
  children: React.ReactNode
  className?: string
  /** How the box arrives: a sheet from the bottom on a phone, a pop in the middle from `sm` up, unless said. */
  motion?: DialogMotion
  testId?: string
}) {
  const requestClose = useCallback(() => {
    onRequestClose()
  }, [onRequestClose])

  return (
    <DialogPopup
      open={open}
      onOpenChange={(next) => { if (!next) requestClose() }}
      motion={motion}
      overlayClassName="md:bg-transparent"
      data-testid={testId}
      aria-label={label}
      className={cn("glass-overlay absolute", className)}
      // The dialog itself takes focus, so a field that wants it asks (the title's own autoFocus).
      onOpenAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest("[data-todo-field-edit]")) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        requestClose()
      }}
    >
      <ExitReport open={open} onClosed={onClosed} />
      {children}
    </DialogPopup>
  )
}
