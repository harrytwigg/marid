import * as React from "react"
import { Slot } from "radix-ui"
import { Focusable } from "react-aria-components/Focusable"
import { Tooltip as AriaTooltip, TooltipTrigger as AriaTooltipTrigger } from "react-aria-components/Tooltip"

import { cn } from "@/lib/utils"
import { placementOf, type Align, type OverlayDomProps, type Side } from "./overlay-placement"

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

/** What React Aria's tooltip would fight us over, so it is not passed on: its own `role`, and the key and
 *  focus handlers its trigger and Escape handling own. */
const DROPPED = new Set(["role", "onKeyDown", "onKeyUp", "onKeyPress", "onFocus", "onBlur"])

/** The attributes React Aria does not forward but the element can carry: `title`, and every `aria-*` it does
 *  not take itself (it takes `aria-label`, `aria-labelledby`, `aria-describedby` and `aria-details`). */
const SET_BY_HAND = /^(title|aria-(?!label$|labelledby$|describedby$|details$).+)$/

/** Puts those attributes on the surface by hand, and takes them off again when they change or it goes. The
 *  surface is not there while the tooltip is closed (React Aria renders nothing), so it is held in state by a
 *  callback ref and the attributes follow it: opened by hover, closed and opened again, they are on each time. */
function useAttributes(node: HTMLElement | null, attributes: Record<string, string>) {
  const key = JSON.stringify(attributes)
  React.useLayoutEffect(() => {
    if (!node) return
    const entries = Object.entries(JSON.parse(key) as Record<string, string>)
    for (const [name, value] of entries) node.setAttribute(name, value)
    return () => {
      for (const [name] of entries) node.removeAttribute(name)
    }
  }, [node, key])
}

/** A caller's `style` is spread after React Aria's own, so these would move the tooltip off its trigger. */
const POSITIONING = new Set(["position", "top", "right", "bottom", "left", "inset", "zIndex", "transform", "translate"])

function withoutPositioning(style: React.CSSProperties | undefined): React.CSSProperties | undefined {
  if (!style) return style
  return Object.fromEntries(Object.entries(style).filter(([name]) => !POSITIONING.has(name)))
}

/**
 * Takes the props the Radix content took (the SDK declares every div prop), and forwards what can be
 * forwarded: `className`, `style` (but not the properties that position it), `data-*`, `aria-*`, `title`,
 * `id` and the mouse, pointer and touch handlers. `role` and the key and focus handlers are ignored: the
 * role is `tooltip`, and Escape, focus and blur are React Aria's.
 */
function TooltipContent({
  className,
  side = "top",
  align = "center",
  sideOffset = 6,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  children?: React.ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
}) {
  const [surface, setSurface] = React.useState<HTMLDivElement | null>(null)
  const byHand: Record<string, string> = {}
  const forwarded: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(props)) {
    if (DROPPED.has(name)) continue
    if (SET_BY_HAND.test(name)) {
      if (value !== undefined && value !== null && value !== false) byHand[name] = String(value)
    } else {
      forwarded[name] = name === "style" ? withoutPositioning(value as React.CSSProperties | undefined) : value
    }
  }
  useAttributes(surface, byHand)
  return (
    <AriaTooltip
      ref={setSurface}
      data-slot="tooltip-content"
      placement={placementOf(side, align)}
      offset={sideOffset}
      className={cn("tooltip glass-overlay max-w-[260px] break-words px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]", className)}
      {...(forwarded as OverlayDomProps)}
    >
      {children}
    </AriaTooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
