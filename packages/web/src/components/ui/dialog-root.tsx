import * as React from "react"
import { Slot } from "./slot"

import { returnFocusTo } from "./menu-focus"
import { preloadQuietly, warmPopupOnce } from "./dialog-load"

/* The open state of a dialog, and the parts that act on it: the root, the trigger and the close. See `dialog.tsx`. */

export type DialogRoot = {
  open: boolean
  /** Whether it has been open: from then on the popup stays mounted, so React Aria can run the exit. */
  hasOpened: boolean
  change: (open: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
  contentId: string
  titleId: string
  descriptionId: string
  hasTitle: boolean
  setHasTitle: (present: boolean) => void
  hasDescription: boolean
  setHasDescription: (present: boolean) => void
}

const DialogContext = React.createContext<DialogRoot | null>(null)

export function useDialogRoot(): DialogRoot {
  const root = React.useContext(DialogContext)
  if (!root) throw new Error("A dialog part must be inside a Dialog")
  return root
}

type DialogProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Accepted for the plugin SDK's sake; a dialog is always modal. */
  modal?: boolean
  children?: React.ReactNode
}

export function Dialog({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen)
  const [everOpen, setEverOpen] = React.useState(false)
  const [hasTitle, setHasTitle] = React.useState(false)
  const [hasDescription, setHasDescription] = React.useState(false)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const isOpen = open ?? uncontrolled
  if (isOpen && !everOpen) setEverOpen(true)
  const onChange = React.useRef(onOpenChange)
  onChange.current = onOpenChange
  const change = React.useCallback((next: boolean) => {
    setUncontrolled(next)
    onChange.current?.(next)
    // React Aria puts focus back where it was, but not in a browser whose buttons take none from a press.
    if (!next) returnFocusTo(triggerRef.current)
  }, [])
  const id = React.useId()
  React.useEffect(warmPopupOnce, [])
  const root = React.useMemo<DialogRoot>(
    () => ({
      open: isOpen,
      hasOpened: everOpen || isOpen,
      change,
      triggerRef,
      contentId: `${id}-content`,
      titleId: `${id}-title`,
      descriptionId: `${id}-description`,
      hasTitle,
      setHasTitle,
      hasDescription,
      setHasDescription,
    }),
    [isOpen, everOpen, change, id, hasTitle, hasDescription],
  )
  return <DialogContext.Provider value={root}>{children}</DialogContext.Provider>
}

export function DialogTrigger({
  asChild = false,
  onClick,
  onPointerEnter,
  onFocus,
  onTouchStart,
  ref,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const root = useDialogRoot()
  const Comp = asChild ? Slot : "button"
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      root.triggerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [root.triggerRef, ref],
  )
  return (
    <Comp
      ref={setRef}
      data-slot="dialog-trigger"
      type={asChild ? undefined : "button"}
      aria-haspopup="dialog"
      aria-expanded={root.open}
      aria-controls={root.open ? root.contentId : undefined}
      data-state={root.open ? "open" : "closed"}
      onPointerEnter={(event: React.PointerEvent<HTMLButtonElement>) => { preloadQuietly(); onPointerEnter?.(event) }}
      onFocus={(event: React.FocusEvent<HTMLButtonElement>) => { preloadQuietly(); onFocus?.(event) }}
      onTouchStart={(event: React.TouchEvent<HTMLButtonElement>) => { preloadQuietly(); onTouchStart?.(event) }}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (!event.defaultPrevented) root.change(!root.open)
      }}
      {...props}
    />
  )
}

export function DialogClose({
  asChild = false,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const root = useDialogRoot()
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="dialog-close"
      type={asChild ? undefined : "button"}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (!event.defaultPrevented) root.change(false)
      }}
      {...props}
    />
  )
}

