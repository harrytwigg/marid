import * as React from "react"
import { createPortal } from "react-dom"
import { Slot } from "./slot"

import { MenuContentHost, MenuRootProvider, menuPart, preloadMenuPopup, useMenuRoot } from "./menu-root"
import type { OverlayDomProps } from "./overlay-placement"

/**
 * The context menu: the dropdown menu's parts, opened at a point instead of from
 * a button. React Aria has no context menu, so the trigger opens it on the
 * browser's `contextmenu` (right-click, and the touch long press that fires it),
 * on Shift+F10 and the Menu key, and on a touch or pen press held for 700 ms
 * (iOS fires no `contextmenu`). The menu is placed against a zero-size element
 * at the point, which is the element React Aria measures. Focus goes to the
 * first item when it opens from the keyboard, to the list otherwise, and returns
 * to what had it. As in the dropdown menu, a press outside closes it and goes on
 * to what it landed on, and the part of it that is React Aria loads on first use.
 */

export type MenuPoint = { x: number; y: number; keyboard?: boolean }

type PointContextValue = { point: MenuPoint | null; show: (point: MenuPoint) => void }
const PointContext = React.createContext<PointContextValue | null>(null)

function usePoint() {
  const context = React.useContext(PointContext)
  if (!context) throw new Error("A context menu part must be inside a ContextMenu or PointMenu")
  return context
}

/** The element the menu is placed against: zero-size, at the point, outside the layout. */
function PointAnchor({ point }: { point: MenuPoint }) {
  const root = useMenuRoot()
  return createPortal(
    <span
      ref={root.triggerRef as React.Ref<HTMLSpanElement>}
      aria-hidden
      data-context-menu-anchor
      className="pointer-events-none fixed size-0"
      style={{ left: point.x, top: point.y }}
    />,
    document.body,
  )
}

/** A menu open at `point` until `onOpenChange(false)`, with no trigger of its own. */
function PointMenu({
  point,
  onOpenChange,
  show = () => {},
  children,
}: {
  point: MenuPoint | null
  onOpenChange?: (open: boolean) => void
  show?: (point: MenuPoint) => void
  children?: React.ReactNode
}) {
  const value = React.useMemo(() => ({ point, show }), [point, show])
  return (
    <MenuRootProvider open={point !== null} onOpenChange={onOpenChange} openedBy={point?.keyboard ? "keyboard" : "pointer"} returnFocus={false}>
      <PointContext.Provider value={value}>
        {point ? <PointAnchor point={point} /> : null}
        {children}
      </PointContext.Provider>
    </MenuRootProvider>
  )
}

function ContextMenu({ children, onOpenChange }: { children?: React.ReactNode; modal?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [point, setPoint] = React.useState<MenuPoint | null>(null)
  return (
    <PointMenu
      point={point}
      show={setPoint}
      onOpenChange={(open) => {
        if (!open) setPoint(null)
        onOpenChange?.(open)
      }}
    >
      {children}
    </PointMenu>
  )
}

const LONG_PRESS_MS = 700
const LONG_PRESS_SLOP = 10
/** How long after the finger lifts the mouse events a browser sends for the lift are still swallowed. */
const RELEASE_GUARD_MS = 600

/**
 * A menu opened by a held touch appears under the finger, and when the finger lifts the browser sends the events of
 * a press: `mousedown` (which moves focus to what is under it and so would close the menu), `mouseup` and `click`
 * (which would act on the row). They belong to the hold, not to a new press, so they are swallowed until shortly
 * after the lift.
 */
function useReleaseGuard() {
  const remove = React.useRef<(() => void) | null>(null)
  const disarm = React.useCallback(() => remove.current?.(), [])
  React.useEffect(() => disarm, [disarm])
  return React.useCallback(() => {
    disarm()
    const swallow = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const mouse = ["mousedown", "mouseup", "click"]
    const lift = ["pointerup", "pointercancel"]
    let timer = 0
    const done = () => {
      window.clearTimeout(timer)
      for (const type of mouse) document.removeEventListener(type, swallow, true)
      for (const type of lift) document.removeEventListener(type, onLift, true)
      remove.current = null
    }
    const onLift = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(done, RELEASE_GUARD_MS)
    }
    for (const type of mouse) document.addEventListener(type, swallow, true)
    for (const type of lift) document.addEventListener(type, onLift, true)
    remove.current = done
  }, [disarm])
}

/** A touch or pen held still for `LONG_PRESS_MS` opens the menu at the finger (iOS sends no `contextmenu`). */
function useLongPress(show: (point: MenuPoint) => void, guardRelease: () => void) {
  const hold = React.useRef<{ timer: number; x: number; y: number } | null>(null)
  const cancel = React.useCallback(() => {
    if (hold.current) window.clearTimeout(hold.current.timer)
    hold.current = null
  }, [])
  React.useEffect(() => cancel, [cancel])
  const start = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") return
    const { clientX: x, clientY: y } = event
    cancel()
    hold.current = { x, y, timer: window.setTimeout(() => { hold.current = null; guardRelease(); show({ x, y }) }, LONG_PRESS_MS) }
  }
  const move = (event: React.PointerEvent) => {
    const from = hold.current
    if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > LONG_PRESS_SLOP) cancel()
  }
  return { start, move, cancel, holding: () => hold.current !== null }
}

/** The handlers that open the menu from `show`: contextmenu, Shift+F10 or Menu, and a held touch. */
function useOpeners(show: (point: MenuPoint) => void, props: React.ComponentProps<"span">) {
  const guardRelease = useReleaseGuard()
  const press = useLongPress(show, guardRelease)
  return {
    onContextMenu: (event: React.MouseEvent<HTMLSpanElement>) => {
      props.onContextMenu?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      // Android sends this for a held touch, with the finger still down.
      if (press.holding()) {
        press.cancel()
        guardRelease()
      }
      show({ x: event.clientX, y: event.clientY })
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
      props.onKeyDown?.(event)
      if (event.defaultPrevented || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return
      event.preventDefault()
      const rect = (event.target as Element).getBoundingClientRect()
      show({ x: rect.left + Math.min(rect.width / 2, 24), y: rect.bottom, keyboard: true })
    },
    onPointerDown: (event: React.PointerEvent<HTMLSpanElement>) => {
      props.onPointerDown?.(event)
      press.start(event)
    },
    onPointerMove: (event: React.PointerEvent<HTMLSpanElement>) => {
      props.onPointerMove?.(event)
      press.move(event)
    },
    onPointerUp: (event: React.PointerEvent<HTMLSpanElement>) => {
      props.onPointerUp?.(event)
      press.cancel()
    },
    onPointerCancel: (event: React.PointerEvent<HTMLSpanElement>) => {
      props.onPointerCancel?.(event)
      press.cancel()
    },
    onPointerEnter: (event: React.PointerEvent<HTMLSpanElement>) => {
      props.onPointerEnter?.(event)
      void preloadMenuPopup().catch(() => {})
    },
  }
}

function ContextMenuTrigger({ asChild = false, ...props }: React.ComponentProps<"span"> & { asChild?: boolean }) {
  const { point, show } = usePoint()
  const Comp = asChild ? Slot : "span"
  return <Comp data-slot="context-menu-trigger" data-menu-open={point ? "" : undefined} {...props} {...useOpeners(show, props)} />
}

function ContextMenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

function ContextMenuContent(props: OverlayDomProps & { children?: React.ReactNode; "aria-label"?: string }) {
  return <MenuContentHost data-slot="context-menu-content" sideOffset={0} aria-label="Context menu" {...props} />
}

const ContextMenuGroup = menuPart("Group", "context-menu-group")
const ContextMenuLabel = menuPart("Label", "context-menu-label")
const ContextMenuItem = menuPart("Item", "context-menu-item")
const ContextMenuCheckboxItem = menuPart("CheckboxItem", "context-menu-checkbox-item")
const ContextMenuRadioGroup = menuPart("RadioGroup", "context-menu-radio-group")
const ContextMenuRadioItem = menuPart("RadioItem", "context-menu-radio-item")
const ContextMenuSeparator = menuPart("Separator", "context-menu-separator")
const ContextMenuSub = menuPart("Sub", "context-menu-sub")
const ContextMenuSubTrigger = menuPart("SubTrigger", "context-menu-sub-trigger")
const ContextMenuSubContent = menuPart("SubContent", "context-menu-sub-content")

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={["ml-auto text-xs tracking-widest text-muted-foreground", className].filter(Boolean).join(" ")}
      {...props}
    />
  )
}

export {
  PointMenu,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
