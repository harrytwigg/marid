import * as React from "react"
import { Slot } from "radix-ui"
import { Popover } from "react-aria-components/Popover"

import { cn } from "@/lib/utils"
import { placementOf, type Align, type Side } from "./overlay-placement"

/**
 * A read that opens beside its trigger on hover or focus and goes when the
 * pointer or focus leaves, drawn by React Aria's Popover (positioning, flipping,
 * the portal and the exit) in HeroUI's popover classes. It is not a dialog and
 * not modal: nothing inside takes focus, the page stays live, and the trigger
 * is linked to the card with `aria-describedby` while it is open.
 *
 * Opens after `openDelay` on pointer-enter or focus (a touch pointer never
 * opens it), closes after `closeDelay` on pointer-leave or blur, and closes at
 * once on Escape, wherever focus is; after Escape it stays shut until the
 * pointer or focus has left and come back. Controlled with `open` and
 * `onOpenChange`, or left to itself.
 */

interface HoverCardState {
  open: boolean
  id: string
  triggerRef: React.RefObject<HTMLElement | null>
  /** Ask to open (true) or close (false) after the matching delay. */
  intend: (open: boolean) => void
  /** Close now and stay shut until the next time the trigger is entered. */
  dismiss: () => void
  /** Keep the card where it is: the pointer has crossed onto it. */
  hold: () => void
}

const HoverCardContext = React.createContext<HoverCardState | null>(null)

function useHoverCardState(): HoverCardState {
  const state = React.useContext(HoverCardContext)
  if (!state) throw new Error("HoverCard parts must be rendered inside <HoverCard>")
  return state
}

/** Open and close intent with its delays, and Escape. `intend(true)` opens the
 *  card after `openDelay` unless it was dismissed since the pointer or focus last
 *  left; `intend(false)` closes it after `closeDelay`; `hold` cancels a pending
 *  change; `dismiss` closes it now. */
function useHoverIntent({
  open,
  set,
  openDelay,
  closeDelay,
}: {
  open: boolean
  set: (open: boolean) => void
  openDelay: number
  closeDelay: number
}) {
  const timer = React.useRef<number | undefined>(undefined)
  const dismissed = React.useRef(false)
  const openRef = React.useRef(open)
  openRef.current = open

  const clear = React.useCallback(() => window.clearTimeout(timer.current), [])
  const intend = React.useCallback(
    (next: boolean) => {
      clear()
      if (next && dismissed.current) return
      if (!next) dismissed.current = false
      if (next === openRef.current) return
      timer.current = window.setTimeout(() => set(next), next ? openDelay : closeDelay)
    },
    [clear, set, openDelay, closeDelay],
  )
  const dismiss = React.useCallback(() => {
    clear()
    dismissed.current = true
    set(false)
  }, [clear, set])

  React.useEffect(() => clear, [clear])
  // Escape closes the card wherever focus is: a card opened by the pointer
  // leaves focus elsewhere, and it still has to be dismissible.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) dismiss()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, dismiss])
  return { intend, dismiss, hold: clear }
}

function HoverCard({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  openDelay = 700,
  closeDelay = 300,
  children,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  openDelay?: number
  closeDelay?: number
  children?: React.ReactNode
}) {
  const id = React.useId()
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const [inner, setInner] = React.useState(defaultOpen)
  const open = openProp ?? inner
  const openRef = React.useRef(open)
  openRef.current = open
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const set = React.useCallback((next: boolean) => {
    if (next === openRef.current) return
    openRef.current = next
    setInner(next)
    onOpenChangeRef.current?.(next)
  }, [])
  const { intend, dismiss, hold } = useHoverIntent({ open, set, openDelay, closeDelay })

  const state = React.useMemo<HoverCardState>(
    () => ({ open, id, triggerRef, intend, dismiss, hold }),
    [open, id, intend, dismiss, hold],
  )
  return <HoverCardContext.Provider value={state}>{children}</HoverCardContext.Provider>
}

/** The element that opens the card. With `asChild` its props go to the one
 *  child, as in the other adapters; the child must forward `ref`. */
function HoverCardTrigger({
  asChild = false,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const { open, id, triggerRef, intend } = useHoverCardState()
  const Comp = asChild ? Slot.Root : "a"
  return (
    <Comp
      data-slot="hover-card-trigger"
      ref={triggerRef as React.Ref<HTMLAnchorElement>}
      aria-describedby={open ? id : undefined}
      onPointerEnter={(event: React.PointerEvent<HTMLAnchorElement>) => {
        onPointerEnter?.(event)
        if (event.pointerType !== "touch") intend(true)
      }}
      onPointerLeave={(event: React.PointerEvent<HTMLAnchorElement>) => {
        onPointerLeave?.(event)
        intend(false)
      }}
      onFocus={(event: React.FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(event)
        intend(true)
      }}
      onBlur={(event: React.FocusEvent<HTMLAnchorElement>) => {
        onBlur?.(event)
        intend(false)
      }}
      {...props}
    />
  )
}

function HoverCardContent({
  className,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  collisionPadding = 8,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  children?: React.ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  collisionPadding?: number
}) {
  const { open, id, triggerRef, intend, dismiss, hold } = useHoverCardState()
  return (
    <Popover
      data-slot="hover-card-content"
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
      triggerRef={triggerRef}
      isNonModal
      placement={placementOf(side, align)}
      offset={sideOffset}
      crossOffset={alignOffset}
      containerPadding={collisionPadding}
      onPointerEnter={hold}
      onPointerLeave={() => intend(false)}
      className={cn("popover glass-overlay motion-reduce:animate-none", className)}
      {...props}
    >
      {/* The trigger's `aria-describedby` names this: React Aria's popover takes no
          id or role of its own, and it adds a visually hidden dismiss button that
          must stay outside a `tooltip`. */}
      <div id={id} role="tooltip">
        {children}
      </div>
    </Popover>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
