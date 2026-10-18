import * as React from "react"
import { Slot } from "radix-ui"
import { Dialog, DialogTrigger } from "react-aria-components/Dialog"
import { Popover as AriaPopover } from "react-aria-components/Popover"
import { Pressable } from "react-aria-components/Pressable"

import { cn } from "@/lib/utils"
import { placementOf, type Align, type Side } from "./overlay-placement"

/**
 * A click-to-open popover over React Aria's Popover and Dialog, in HeroUI's
 * popover classes (not its component, which adds a variants runtime for the same
 * markup). The content is a `dialog` named by `aria-label`: focus moves into it
 * on open and returns to the trigger on close, Escape and an outside press
 * close it, and the trigger carries `aria-expanded` and `aria-controls`.
 * Anything outside it is hidden from a screen reader while it is open.
 *
 * Same parts and props as the Radix popover this replaces, except `align`
 * defaults to start as before and `collisionPadding` is the `containerPadding`
 * React Aria takes. The trigger is a `Pressable`: it must be a native button or
 * link, or something that passes `ref` and the DOM props through.
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

type PopoverContentProps = Omit<React.ComponentProps<"div">, "children"> & {
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
  return (
    <AriaPopover
      data-slot="popover-content"
      placement={placementOf(side, align)}
      offset={sideOffset}
      containerPadding={collisionPadding}
      className={cn("popover glass-overlay", className)}
      {...props}
    >
      <Dialog aria-label={ariaLabel} className="outline-none">
        {children}
      </Dialog>
    </AriaPopover>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
