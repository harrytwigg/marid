import * as React from "react"
import { Slot } from "radix-ui"
import { Focusable } from "react-aria-components/Focusable"
import { Tooltip as AriaTooltip, TooltipTrigger as AriaTooltipTrigger } from "react-aria-components/Tooltip"

import { cn } from "@/lib/utils"
import { placementOf, type Align, type Side } from "./overlay-placement"

/**
 * The same four parts as ever (a provider, a root, a trigger, content), drawn
 * by React Aria's Tooltip in HeroUI's tooltip classes, which positions it, links
 * it to its trigger with `aria-describedby`, opens it on hover and on keyboard
 * focus, and closes it on Escape, blur and pointer-down. It is React Aria
 * itself, not HeroUI's Tooltip component, which would add its variants runtime
 * (about 14 KB gzip on the chat route) for the same markup and classes.
 *
 * Only the plugin SDK renders these. A tooltip in the always-loaded shell would
 * put React Aria on the initial path, over its budget, so first-party chrome
 * uses a CSS reveal or `title` instead (the nav rail's labels are one).
 *
 * Against the Radix tooltip this replaces: the trigger is any focusable
 * element, and `asChild` hands the props to it; the open delay is 300ms and
 * there is no close delay, as before; `align` and `side` give the placement;
 * `avoidCollisions`, `collisionPadding` and `sticky` are gone, since React Aria
 * always flips and shifts to stay on screen.
 */

const OPEN_DELAY_MS = 300

const DelayContext = React.createContext(OPEN_DELAY_MS)

function TooltipProvider({
  delayDuration = OPEN_DELAY_MS,
  children,
}: {
  delayDuration?: number
  children?: React.ReactNode
}) {
  return <DelayContext.Provider value={delayDuration}>{children}</DelayContext.Provider>
}

/** Carries its own provider so a single tooltip works on its own. Wrap a group
 *  in `TooltipProvider` when they should share one open delay. */
function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  children,
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
  children?: React.ReactNode
}) {
  const shared = React.useContext(DelayContext)
  return (
    <AriaTooltipTrigger
      isOpen={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      delay={delayDuration ?? shared}
      closeDelay={0}
    >
      {children}
    </AriaTooltipTrigger>
  )
}

function TooltipTrigger({
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  // `Focusable` takes the hover, focus and key handlers React Aria's trigger
  // state hands out and merges them onto this one element, so the trigger stays
  // the button (or the child) it was and no wrapper carries `role=button`.
  return (
    <Focusable>
      <Comp data-slot="tooltip-trigger" type={asChild ? undefined : "button"} {...props} />
    </Focusable>
  )
}

function TooltipContent({
  className,
  side = "top",
  align = "center",
  sideOffset = 6,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "onAnimationEnd"> & {
  side?: Side
  align?: Align
  sideOffset?: number
}) {
  return (
    <AriaTooltip
      data-slot="tooltip-content"
      placement={placementOf(side, align)}
      offset={sideOffset}
      className={cn("tooltip glass-overlay max-w-[260px] break-words px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]", className)}
      {...props}
    >
      {children}
    </AriaTooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
