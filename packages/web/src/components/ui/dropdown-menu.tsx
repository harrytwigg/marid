import * as React from "react"
import { Slot } from "radix-ui"

import { MenuContentHost, MenuRootProvider, menuPart, preloadMenuPopup, useMenuRoot, type MenuRootProps } from "./menu-root"
import type { MenuSearch } from "./menu-popup"
import type { MenuItemProps } from "./menu-parts"
import type { Align, OverlayDomProps, Side } from "./overlay-placement"

/**
 * The dropdown menu: React Aria's Menu behind the parts and props of the Radix
 * one it replaces, in HeroUI's menu classes and the overlay material. Keyboard,
 * typeahead, submenus, Escape, and focus returning to the trigger are React
 * Aria's. Everything that is React Aria loads when a menu is first opened
 * (`menu-root.tsx` says why), so this file, which the shell imports, holds the
 * open state, the native trigger and thin parts that hand over to the loaded
 * ones.
 *
 * Differences from the Radix menu (none reaches the plugin SDK's types):
 *   - A press outside closes the menu and goes on to what it landed on (the
 *     Radix one was modal and swallowed it), as the popovers do.
 *   - `modal` is accepted and ignored; `DropdownMenuPortal` passes through.
 *   - An item's `onClick` takes no event (React Aria's item gives none).
 *   - The trigger carries `aria-expanded` and `aria-haspopup`, and
 *     `data-menu-open` while open, in place of Radix's `data-state="open"`.
 *   - The menu is a collection: only items, separators, labels and submenus
 *     belong in it (see `menu-parts.tsx`).
 */

function DropdownMenu({ children, ...props }: MenuRootProps & { modal?: boolean; children?: React.ReactNode }) {
  const { open, defaultOpen, onOpenChange } = props
  return <MenuRootProvider {...{ open, defaultOpen, onOpenChange }}>{children}</MenuRootProvider>
}

function DropdownMenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}

type TriggerProps = React.ComponentProps<"button"> & { asChild?: boolean }

/** Runs the caller's handler first; the menu's own runs unless it called `preventDefault`. */
function after<E extends React.SyntheticEvent>(own: ((event: E) => void) | undefined, then: (event: E) => void) {
  return (event: E) => {
    own?.(event)
    if (!event.defaultPrevented) then(event)
  }
}

const fetchPopup = () => void preloadMenuPopup().catch(() => {})

function DropdownMenuTrigger({ asChild = false, ...props }: TriggerProps) {
  const root = useMenuRoot()
  const Comp = asChild ? Slot.Root : "button"
  const { disabled } = props
  return (
    <Comp
      ref={root.triggerRef as React.Ref<HTMLButtonElement>}
      data-slot="dropdown-menu-trigger"
      data-menu-open={root.isOpen ? "" : undefined}
      type={asChild ? undefined : "button"}
      aria-haspopup="menu"
      aria-expanded={root.isOpen}
      aria-controls={root.isOpen ? root.menuId : undefined}
      {...props}
      id={props.id ?? root.triggerId}
      onPointerEnter={after(props.onPointerEnter, fetchPopup)}
      onFocus={after(props.onFocus, fetchPopup)}
      onPointerDown={after(props.onPointerDown, (event) => {
        if (disabled || event.button !== 0 || event.ctrlKey) return
        const wasOpen = root.isOpen
        root.toggle("pointer")
        // Opening takes focus (the pointer press would move it after the menu had taken it) and
        // leaves the press alone otherwise; the trigger is what focus returns to on close.
        if (!wasOpen) {
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
        }
      })}
      onKeyDown={after(props.onKeyDown, (event) => {
        if (disabled || !["Enter", " ", "ArrowDown"].includes(event.key)) return
        event.preventDefault()
        if (event.key === "ArrowDown") root.open("keyboard")
        else root.toggle("keyboard")
      })}
    />
  )
}

type ContentProps = OverlayDomProps & {
  children?: React.ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
  collisionPadding?: number
  /** A search field above the list, for a list a caller filters (additive: Radix had none). */
  search?: MenuSearch
  /** Wraps the search field and the list, for a caller that animates them (additive). */
  wrapBody?: (body: React.ReactNode) => React.ReactNode
}

function DropdownMenuContent(props: ContentProps) {
  return <MenuContentHost data-slot="dropdown-menu-content" {...props} />
}

const DropdownMenuGroup = menuPart("Group", "dropdown-menu-group")
const DropdownMenuLabel = menuPart("Label", "dropdown-menu-label")
const DropdownMenuItem = menuPart("Item", "dropdown-menu-item")
const DropdownMenuCheckboxItem = menuPart("CheckboxItem", "dropdown-menu-checkbox-item")
const DropdownMenuRadioGroup = menuPart("RadioGroup", "dropdown-menu-radio-group")
const DropdownMenuRadioItem = menuPart("RadioItem", "dropdown-menu-radio-item")
const DropdownMenuSeparator = menuPart("Separator", "dropdown-menu-separator")
const DropdownMenuSub = menuPart("Sub", "dropdown-menu-sub")
const DropdownMenuSubTrigger = menuPart("SubTrigger", "dropdown-menu-sub-trigger")
const DropdownMenuSubContent = menuPart("SubContent", "dropdown-menu-sub-content")

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={["ml-auto text-xs tracking-widest text-muted-foreground", className].filter(Boolean).join(" ")}
      {...props}
    />
  )
}

export type { MenuItemProps }
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
