import * as React from "react"
import { Slot } from "radix-ui"
import { Dialog, DialogTrigger, OverlayTriggerStateContext } from "react-aria-components/Dialog"
import { Popover as AriaPopover, PopoverContext } from "react-aria-components/Popover"
import { Pressable } from "react-aria-components/Pressable"

import { cn } from "@/lib/utils"
import { placementOf, type Align, type OverlayDomProps, type Side } from "./overlay-placement"

/**
 * A click-to-open popover over React Aria's Popover and Dialog, in HeroUI's
 * popover classes (not its component, which adds a variants runtime for the same
 * markup). The content is a `dialog` named by `aria-label`: focus moves into it
 * on open and returns to the trigger on close, Escape closes it, and the trigger
 * carries `aria-expanded`, `aria-controls` and `aria-haspopup`.
 *
 * It is not modal, as the Radix popover it replaces was not: the page behind it
 * stays live and unhidden, and a press outside closes it and goes on to what it
 * landed on. React Aria's modal popover would put an underlay over the page,
 * which swallows that press, and, being a React child of the trigger's
 * ancestors, would hand it to their handlers (a chat pane would take focus from
 * the pane the user clicked). So the outside press is closed here instead.
 *
 * Same parts and props as the Radix popover, except `collisionPadding` is the
 * `containerPadding` React Aria takes and `className` lands on the dialog (the
 * card's content: its width, padding, a `max-h-*` and `overflow-*`), because
 * React Aria sets an inline `max-height` on the surface that no class beats.
 * The trigger is a `Pressable`: it must be a native button or link, or
 * something that passes `ref` and the DOM props through.
 */

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}) {
  return (
    <DialogTrigger isOpen={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {children}
    </DialogTrigger>
  )
}

function PopoverTrigger({
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Pressable>
      <Comp data-slot="popover-trigger" aria-haspopup="dialog" type={asChild ? undefined : "button"} {...props} />
    </Pressable>
  )
}

/** The popover's trigger, from the context React Aria's trigger provides. */
function useTriggerRef(): React.RefObject<Element | null> | undefined {
  const context = React.useContext(PopoverContext) as { triggerRef?: React.RefObject<Element | null> } | null
  return context?.triggerRef
}

/** Closes the popover on a press that lands outside both it and its trigger (a
 *  press on the trigger is the trigger's own toggle). Listens in the capture
 *  phase, so a handler that stops propagation cannot hide the press from it. */
function useClosesOnOutsidePress(surface: React.RefObject<HTMLElement | null>, triggerRef: React.RefObject<Element | null> | undefined) {
  const state = React.useContext(OverlayTriggerStateContext)
  const isOpen = state?.isOpen ?? false
  const close = state?.close
  React.useEffect(() => {
    if (!isOpen || !close) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (surface.current?.contains(target) || triggerRef?.current?.contains(target))) return
      close()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [isOpen, close, surface, triggerRef])
}

type PopoverContentProps = OverlayDomProps & {
  children?: React.ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
  collisionPadding?: number
  "aria-label": string
}

function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 8,
  collisionPadding = 8,
  "aria-label": ariaLabel,
  children,
  ...props
}: PopoverContentProps) {
  const surface = React.useRef<HTMLElement | null>(null)
  const triggerRef = useTriggerRef()
  useClosesOnOutsidePress(surface, triggerRef)
  return (
    <AriaPopover
      ref={surface}
      data-slot="popover-content"
      isNonModal
      // Focus moving from the dialog to the trigger is the start of the trigger's own press, which
      // toggles the popover shut; closing on that blur would let the press open it again.
      shouldCloseOnInteractOutside={(element) => !triggerRef?.current?.contains(element)}
      placement={placementOf(side, align)}
      offset={sideOffset}
      containerPadding={collisionPadding}
      className="popover glass-overlay overflow-hidden"
      {...props}
    >
      <Dialog aria-label={ariaLabel} className={cn("outline-none", className)}>
        {children}
      </Dialog>
    </AriaPopover>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
