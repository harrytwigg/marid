import * as React from "react"
import { CheckIcon, CircleIcon } from "lucide-react"
import { MenuSection } from "react-aria-components/Menu"

import { cn } from "@/lib/utils"
import { MenuItemPart, textOf, type MenuItemProps } from "./menu-parts"

/** The checkbox and radio rows of a menu: items whose selected state is drawn as a mark in the leading slot. */

const SELECTABLE_CLASS = "gap-2 py-1.5 pr-2 pl-8"
const INDICATOR_CLASS = "pointer-events-none absolute left-2 flex size-3.5 items-center justify-center"

type Selectable = Omit<MenuItemProps, "children" | "onClick"> & { slot: string; children?: React.ReactNode }

/** The state of a checkbox or radio row: a mark in the leading slot when it is chosen. */
function SelectableItem({ slot, className, children, mark, ...props }: Selectable & { mark: React.ReactNode }) {
  return (
    <MenuItemPart slot={slot} className={cn(SELECTABLE_CLASS, className)} textValue={props.textValue ?? textOf(children)} {...props}>
      {({ isSelected }) => (
        <>
          <span className={INDICATOR_CLASS}>{isSelected ? mark : null}</span>
          {children}
        </>
      )}
    </MenuItemPart>
  )
}

const RadioGroupContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void } | null>(null)

/** One choice among several. Choosing it reports its value, even when it is already the chosen one. */
export function MenuRadioGroupPart({ slot, value, onValueChange, children, className, ...props }: { slot: string; value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode; className?: string; "aria-label"?: string }) {
  const context = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange])
  return (
    <RadioGroupContext.Provider value={context}>
      <MenuSection data-slot={slot} className={cn("menu-section", className)} selectionMode="single" disallowEmptySelection selectedKeys={value === undefined ? [] : [value]} {...props}>
        {children}
      </MenuSection>
    </RadioGroupContext.Provider>
  )
}

export function MenuRadioItemPart({ value, onSelect, ...props }: Selectable & { value: string }) {
  const group = React.useContext(RadioGroupContext)
  return (
    <SelectableItem
      {...props}
      id={value}
      mark={<CircleIcon className="size-2 fill-current" />}
      onSelect={(event) => {
        onSelect?.(event)
        group?.onValueChange?.(value)
      }}
    />
  )
}

export function MenuCheckboxItemPart({ checked, onCheckedChange, onSelect, children, ...props }: Selectable & { checked?: boolean | "indeterminate"; onCheckedChange?: (checked: boolean) => void }) {
  const id = React.useId()
  return (
    <MenuSection className="menu-section" selectionMode="multiple" selectedKeys={checked ? [id] : []} aria-label={textOf(children)}>
      <SelectableItem
        {...props}
        id={id}
        mark={<CheckIcon className="size-4" />}
        onSelect={(event) => {
          onSelect?.(event)
          onCheckedChange?.(!checked)
        }}
      >
        {children}
      </SelectableItem>
    </MenuSection>
  )
}
