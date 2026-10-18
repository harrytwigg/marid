import * as React from "react"

import type { MenuParts, MenuPopupProps } from "./menu-popup"

/**
 * The part of the menus that is always loaded: the open state, the trigger's
 * wiring, and the loader of everything that is React Aria. The menus sit in the
 * always-loaded shell (a session row, the chat header), where React Aria's Menu,
 * Popover and collections would add about 35 KB gzip to the initial path, so the
 * menu is a native button until it is opened and `menu-popup.tsx` loads the first
 * time one is. Nothing on screen is swapped: the trigger is the same element
 * before and after, and the popup module is fetched when the pointer reaches the
 * trigger or it takes focus, so it is usually there by the press.
 */

export type OpenedBy = "pointer" | "keyboard"

export type MenuRoot = {
  isOpen: boolean
  /** Whether the menu has been open: from then on its popup stays mounted, so React Aria can run the exit. */
  hasOpened: boolean
  openedBy: OpenedBy
  change: (open: boolean) => void
  open: (by: OpenedBy) => void
  toggle: (by: OpenedBy) => void
  /** Called by an item whose `onSelect` prevented the default: the close that follows is ignored. */
  keepOpen: () => void
  /** The trigger's element, or for a context menu the element at the pointer. */
  triggerRef: React.RefObject<HTMLElement | null>
  triggerId: string
  menuId: string
}

const MenuRootContext = React.createContext<MenuRoot | null>(null)

export function useMenuRoot(): MenuRoot {
  const root = React.useContext(MenuRootContext)
  if (!root) throw new Error("A menu part must be inside a DropdownMenu, ContextMenu or PointMenu")
  return root
}

export type MenuRootProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** For a menu its owner opens: how it was asked for, which decides where focus goes first. */
  openedBy?: OpenedBy
  /** Whether focus goes back to the trigger on close. Not for a menu placed at a point, which has no trigger to focus. */
  returnFocus?: boolean
}

/** Puts focus back on the trigger once a menu has closed, unless focus has gone somewhere deliberate (a press on
 *  another control, an item that focused a field). React Aria restores focus itself, but not when something else got
 *  there first: a Radix dialog moves focus that leaves its content to the content, and then neither is "the body". */
function returnFocusTo(trigger: HTMLElement | null) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!trigger?.isConnected) return
      const active = document.activeElement
      if (!active || active === document.body || (active !== trigger && active.contains(trigger))) trigger.focus({ preventScroll: true })
    }),
  )
}

function useMenuRootState({ open, defaultOpen = false, onOpenChange, openedBy: forcedOpenedBy, returnFocus = true }: MenuRootProps): MenuRoot {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen)
  const [openedByState, setOpenedBy] = React.useState<OpenedBy>("pointer")
  const [everOpen, setEverOpen] = React.useState(false)
  const keep = React.useRef(false)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const isOpen = open ?? uncontrolled
  if (isOpen && !everOpen) setEverOpen(true)
  const onChange = React.useRef(onOpenChange)
  onChange.current = onOpenChange
  const change = React.useCallback((next: boolean) => {
    // The close that follows a selection is ignored when the item asked to keep the menu open.
    if (!next && keep.current) {
      keep.current = false
      return
    }
    setUncontrolled(next)
    onChange.current?.(next)
    if (!next && returnFocus) returnFocusTo(triggerRef.current)
  }, [returnFocus])
  const open_ = React.useCallback((by: OpenedBy) => { setOpenedBy(by); change(true) }, [change])
  const toggle = React.useCallback((by: OpenedBy) => { if (isOpen) change(false); else open_(by) }, [isOpen, change, open_])
  const keepOpen = React.useCallback(() => {
    keep.current = true
    // The close follows the selection in the same handler; if none does, do not hold the next real one.
    queueMicrotask(() => { keep.current = false })
  }, [])
  const id = React.useId()
  return { isOpen, hasOpened: everOpen || isOpen, openedBy: forcedOpenedBy ?? openedByState, change, open: open_, toggle, keepOpen, triggerRef, triggerId: `${id}-trigger`, menuId: `${id}-menu` }
}

export function MenuRootProvider({ children, ...props }: MenuRootProps & { children?: React.ReactNode }) {
  return <MenuRootContext.Provider value={useMenuRootState(props)}>{children}</MenuRootContext.Provider>
}

/** The popup module, loaded once. A failed load is forgotten, so the next open tries again. */
type PopupModule = typeof import("./menu-popup")
let popup: PopupModule | null = null
let loading: Promise<PopupModule> | null = null

export function preloadMenuPopup(): Promise<PopupModule> {
  loading ??= import("./menu-popup").then(
    (module) => (popup = module),
    (error) => {
      loading = null
      throw error
    },
  )
  return loading
}

/** Closes the menu, and forgets the failed load, when the popup module cannot be fetched (a stale chunk after a deploy). */
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

function PopupHost(props: MenuPopupProps) {
  const module = popup ?? React.use(preloadMenuPopup())
  return <module.default {...props} />
}

/** Renders the menu's content once the menu has been opened, as the popup module's. If the popup fails (its module
 *  cannot be fetched, or it throws) the menu closes and renders nothing until it is next opened, which tries again;
 *  retrying at once would fail at once, forever. */
export function MenuContentHost({ children, ...props }: Omit<MenuPopupProps, "root">) {
  const root = useMenuRoot()
  const [failed, setFailed] = React.useState(false)
  // A fresh open clears the failure. Done while rendering, so it lands before the attempt it allows and
  // cannot clear the failure of that attempt.
  const [wasOpen, setWasOpen] = React.useState(root.isOpen)
  if (root.isOpen !== wasOpen) {
    setWasOpen(root.isOpen)
    if (root.isOpen) setFailed(false)
  }
  if (!root.hasOpened || failed) return null
  return (
    <LoadBoundary
      onFail={() => {
        setFailed(true)
        root.change(false)
      }}
    >
      <React.Suspense fallback={null}>
        <PopupHost root={root} {...props}>
          {children}
        </PopupHost>
      </React.Suspense>
    </LoadBoundary>
  )
}

const PartsContext = React.createContext<MenuParts | null>(null)
export const MenuPartsProvider = PartsContext.Provider

/** The items, labels and separators of the loaded popup: a part is only ever rendered inside it. */
export function useMenuParts(): MenuParts {
  const parts = React.useContext(PartsContext)
  if (!parts) throw new Error("A menu part must be inside a menu's content")
  return parts
}

type PartProps<K extends keyof MenuParts> = Omit<React.ComponentProps<MenuParts[K]>, "slot">

/** A part of the menu as the app imports it: it renders the loaded popup's part of that name, with its `data-slot`. */
export function menuPart<K extends keyof MenuParts>(key: K, slot: string) {
  const Part = (props: PartProps<K>) => {
    const Loaded = useMenuParts()[key] as React.ComponentType<Record<string, unknown>>
    return <Loaded slot={slot} {...props} />
  }
  Part.displayName = `Menu.${key}`
  return Part
}
