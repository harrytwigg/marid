import * as React from "react"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { DialogPopupProps } from "./dialog-popup"
import { loadedPopup, retryFailedLoad } from "./dialog-load"
import { DialogClose, useDialogRoot, type DialogRoot } from "./dialog-root"

/* The dialog's box, drawn by the popup once it has loaded. See `dialog.tsx`. */

/** Stands where the box will be while the popup is fetched: the scrim, which takes no press. */
function LoadingScrim({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-slot="dialog-loading"
      className={cn("pointer-events-none fixed inset-0 z-50 bg-[var(--scrim)] motion-safe:animate-overlay-in", className)}
    />
  )
}

/** Closes the dialog, and forgets the failed load, when the popup module cannot be fetched (a stale chunk after a deploy). */
class LoadBoundary extends React.Component<{ onFail: () => void; children?: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.onFail()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

function PopupHost(props: DialogPopupProps) {
  const loaded = loadedPopup()
  const module = loaded instanceof Promise ? React.use(loaded) : loaded
  return <module.default {...props} />
}

export type DialogContentProps = Omit<DialogPopupProps, "open" | "onOpenChange" | "children"> & {
  children?: React.ReactNode
  showCloseButton?: boolean
  /** `none` for a dialog that draws its own surface (the lightbox, a palette). */
  material?: "overlay" | "none"
}

/** The ids the popup names itself and is described by: the title and description that are mounted, unless the caller
 *  named the dialog itself. An `aria-describedby` that is present and undefined opts out of the description, as it
 *  did in Radix. */
function useDialogNames(props: Pick<DialogContentProps, "aria-label" | "aria-labelledby" | "aria-describedby">, root: DialogRoot) {
  const described = "aria-describedby" in props ? props["aria-describedby"] : root.hasDescription ? root.descriptionId : undefined
  const named = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined
  const labelled = named || !root.hasTitle ? props["aria-labelledby"] : root.titleId
  return { "aria-describedby": described, "aria-labelledby": labelled }
}

/** Whether the popup's chunk failed to load for this open. A fresh open clears it. */
function useLoadFailure(open: boolean) {
  const [failed, setFailed] = React.useState(false)
  // Cleared while rendering, so it lands before the attempt it allows and cannot clear the failure of that attempt.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      retryFailedLoad()
      setFailed(false)
    }
  }
  return [failed, setFailed] as const
}

const CONTENT_CLASS =
  "absolute top-1/2 left-1/2 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--radius-xl)] p-6 sm:max-w-lg"

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  material = "overlay",
  overlayClassName,
  id,
  ...props
}: DialogContentProps) {
  const root = useDialogRoot()
  const [failed, setFailed] = useLoadFailure(root.open)
  const names = useDialogNames(props, root)
  if (!root.hasOpened || failed) return null
  return (
    <LoadBoundary
      onFail={() => {
        setFailed(true)
        root.change(false)
      }}
    >
      <React.Suspense fallback={root.open ? <LoadingScrim className={overlayClassName} /> : null}>
        <PopupHost
          data-slot="dialog-content"
          open={root.open}
          onOpenChange={root.change}
          overlayClassName={overlayClassName}
          id={id ?? root.contentId}
          className={cn(CONTENT_CLASS, material === "overlay" && "glass-overlay", className)}
          {...props}
          {...names}
        >
          {children}
          {showCloseButton && <DialogCloseButton />}
        </PopupHost>
      </React.Suspense>
    </LoadBoundary>
  )
}

/** The corner X. Last in the box, so the first control of the content is the first in the tab order. */
function DialogCloseButton() {
  return (
    <DialogClose className="focus-outline absolute top-4 right-4 grid size-8 place-items-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0">
      <XIcon size={16} aria-hidden />
      <span className="sr-only">Close</span>
    </DialogClose>
  )
}

