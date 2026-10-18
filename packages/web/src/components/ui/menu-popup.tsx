import * as React from "react"
import { Autocomplete } from "react-aria-components/Autocomplete"
import { Input } from "react-aria-components/Input"
import { MenuContext, RootMenuTriggerStateContext } from "react-aria-components/Menu"
import { OverlayTriggerStateContext } from "react-aria-components/Dialog"
import { PopoverContext } from "react-aria-components/Popover"
import { SearchField } from "react-aria-components/SearchField"
import { useMenuTriggerState } from "react-stately/useMenuTriggerState"

import { cn } from "@/lib/utils"
import {
  MenuCheckboxItemPart,
  MenuGroupPart,
  MenuItemPart,
  MenuLabelPart,
  MenuList,
  MenuRadioGroupPart,
  MenuRadioItemPart,
  MenuSeparatorPart,
  MenuSubContentPart,
  MenuSubPart,
  MenuSubTriggerPart,
  MenuSurface,
} from "./menu-parts"
import { MenuPartsProvider, type MenuRoot } from "./menu-root"
import type { Align, OverlayDomProps, Side } from "./overlay-placement"

/**
 * Everything of the menus that is React Aria, loaded the first time a menu is
 * opened (see `menu-root.tsx`). It stands in for the `MenuTrigger` React Aria
 * would otherwise wrap the trigger in: the same state and the same contexts,
 * provided to a popover and a menu that a native button opens.
 */

export const PARTS = {
  Item: MenuItemPart,
  Label: MenuLabelPart,
  Separator: MenuSeparatorPart,
  Group: MenuGroupPart,
  Sub: MenuSubPart,
  SubTrigger: MenuSubTriggerPart,
  SubContent: MenuSubContentPart,
  RadioGroup: MenuRadioGroupPart,
  RadioItem: MenuRadioItemPart,
  CheckboxItem: MenuCheckboxItemPart,
}
export type MenuParts = typeof PARTS

/** A search field above the list that moves through the items with the arrow keys and filters nothing
 *  itself (the caller owns the list). Focus stays in the field; the item it is on is `data-focused`. */
export type MenuSearch = {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  className?: string
  inputClassName?: string
}

export type MenuPopupProps = OverlayDomProps & {
  root: MenuRoot
  children?: React.ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
  collisionPadding?: number
  /** Names the list when no trigger does (a context menu). */
  "aria-label"?: string
  search?: MenuSearch
  /** Wraps what the surface holds (the search field and the list), for a caller that animates it. */
  wrapBody?: (body: React.ReactNode) => React.ReactNode
}

const noFilter = () => true

function SearchBody({ search, list }: { search: MenuSearch; list: React.ReactNode }) {
  return (
    <Autocomplete inputValue={search.value} onInputChange={search.onChange} filter={noFilter}>
      <SearchField aria-label={search.label} className={cn("px-1 pb-1", search.className)}>
        <Input type="search" placeholder={search.placeholder} className={search.inputClassName} />
      </SearchField>
      {list}
    </Autocomplete>
  )
}

export default function MenuPopup({ root, children, search, wrapBody, "aria-label": ariaLabel, className, ...surface }: MenuPopupProps) {
  const state = useMenuTriggerState({ isOpen: root.isOpen, onOpenChange: root.change })
  const menuRef = React.useRef<HTMLDivElement>(null)
  const labelledBy = ariaLabel ? undefined : root.triggerRef.current?.id || root.triggerId
  const menu = React.useMemo(
    () => ({ id: root.menuId, "aria-labelledby": labelledBy, autoFocus: root.openedBy === "keyboard" ? ("first" as const) : true, onClose: state.close, ref: menuRef }),
    [root.menuId, labelledBy, root.openedBy, state.close],
  )
  const popover = React.useMemo(
    () => ({ trigger: "MenuTrigger", triggerRef: root.triggerRef, scrollRef: menuRef }),
    [root.triggerRef],
  )
  const list = (
    <MenuList aria-label={ariaLabel} className={search ? "min-h-0 overflow-y-auto overscroll-contain" : undefined}>
      {children}
    </MenuList>
  )
  const body = search ? <SearchBody search={search} list={list} /> : list
  return (
    <MenuPartsProvider value={PARTS}>
      <OverlayTriggerStateContext.Provider value={state}>
        <RootMenuTriggerStateContext.Provider value={state}>
          <MenuContext.Provider value={menu}>
            <PopoverContext.Provider value={popover}>
              <MenuSurface className={cn(search && "flex flex-col overflow-hidden", className)} {...surface}>
                {wrapBody ? wrapBody(body) : body}
              </MenuSurface>
            </PopoverContext.Provider>
          </MenuContext.Provider>
        </RootMenuTriggerStateContext.Provider>
      </OverlayTriggerStateContext.Provider>
    </MenuPartsProvider>
  )
}
