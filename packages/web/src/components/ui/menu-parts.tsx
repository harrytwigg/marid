import * as React from "react"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import { Header } from "react-aria-components/Header"
import { Menu, MenuItem, MenuSection, RootMenuTriggerStateContext, SubmenuTrigger } from "react-aria-components/Menu"
import { Popover as AriaPopover, PopoverContext } from "react-aria-components/Popover"
import { Separator } from "react-aria-components/Separator"

import { cn } from "@/lib/utils"
import { OverlayContainerContext } from "./overlay-container"
import { placementOf, type Align, type OverlayDomProps, type Side } from "./overlay-placement"
import { useMenuRoot } from "./menu-root"
import { useClosesOnOutsidePress } from "./use-closes-on-outside-press"

/**
 * What the dropdown and context menus share: React Aria's Menu in HeroUI's menu
 * classes (not its component, which adds a variants runtime for the same
 * markup), under the parts and props the Radix menus had.
 *
 * The menu is a collection, and a collection renders only its own parts: a
 * plain element between items is dropped, and drops every item after it. So
 * anything that is not an item, separator, label or submenu (a note, a toggle,
 * a search field) goes in a `MenuLabel`, which holds any content, or outside the
 * list (see `MenuSurface` and `MenuList`).
 */

export const MENU_SURFACE_ATTR = "data-menu-surface"

/** The trigger element React Aria's menu trigger measures against. */
export function useTriggerRef(): React.RefObject<Element | null> | undefined {
  const context = React.useContext(PopoverContext) as { triggerRef?: React.RefObject<Element | null> } | null
  return context?.triggerRef
}

type SurfaceProps = OverlayDomProps & {
  children?: React.ReactNode
  side?: Side
  align?: Align
  sideOffset?: number
  collisionPadding?: number
}

/** The floating surface: React Aria's popover in the overlay material. Not modal, like the
 *  popovers (see `useClosesOnOutsidePress`); a press inside a submenu is inside the menu. */
export function MenuSurface({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  collisionPadding = 8,
  children,
  ...props
}: SurfaceProps) {
  const popover = React.useContext(PopoverContext) as { trigger?: string } | null
  const isSubmenu = popover?.trigger === "SubmenuTrigger"
  const container = React.useContext(OverlayContainerContext)
  const anchor = useTriggerRef()
  useClosesWithMenu(isSubmenu, anchor)
  // A submenu is placed by its trigger item, and closes with its parent.
  const placed = isSubmenu
    ? {}
    : {
        triggerRef: anchor,
        // Focus moving from the menu to its trigger is the start of the trigger's own press, which
        // toggles the menu shut; closing on that blur would let the press open it again.
        shouldCloseOnInteractOutside: (element: Element) => !anchor?.current?.contains(element),
        placement: placementOf(side, align),
        offset: sideOffset,
        containerPadding: collisionPadding,
      }
  return (
    <AriaPopover
      {...{ [MENU_SURFACE_ATTR]: "" }}
      isNonModal
      {...placed}
      UNSTABLE_portalContainer={container ?? undefined}
      className={cn("popover glass-overlay min-w-[8rem] overflow-y-auto overscroll-contain p-1 text-sm", className)}
      {...props}
    >
      {children}
    </AriaPopover>
  )
}

/** The menu closes on a press outside all of its surfaces (a submenu's is inside it) and its trigger. */
function useClosesWithMenu(isSubmenu: boolean, anchor: React.RefObject<Element | null> | undefined) {
  const rootState = React.useContext(RootMenuTriggerStateContext)
  useClosesOnOutsidePress({
    isOpen: !isSubmenu && (rootState?.isOpen ?? false),
    close: rootState?.close,
    isInside: (target) =>
      Boolean((target as Element).closest?.(`[${MENU_SURFACE_ATTR}]`)) || Boolean(anchor?.current?.contains(target)),
  })
}

/** The list of items inside a surface. */
export function MenuList({ className, children, ...props }: Omit<React.ComponentProps<typeof Menu>, "className"> & { className?: string }) {
  return (
    <Menu className={cn("menu outline-none", className)} {...props}>
      {children}
    </Menu>
  )
}

const ITEM_CLASS =
  "menu-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!"

/** The text typeahead matches: what the item says, since React Aria reads only a string child. */
export function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ""
}

/** DOM attributes an item takes that React Aria's item would drop. */
const EXTRA_ATTRIBUTES = ["title", "aria-checked", "aria-haspopup", "aria-controls", "aria-current"] as const
type ExtraAttributes = Partial<Record<(typeof EXTRA_ATTRIBUTES)[number], string | boolean>>

export type ItemState = { isSelected: boolean }

export type MenuItemProps = ExtraAttributes & {
  id?: string
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode | ((state: ItemState) => React.ReactNode)
  inset?: boolean
  variant?: "default" | "destructive"
  disabled?: boolean
  /** The item is the link its one child, an `a`, describes. */
  asChild?: boolean
  textValue?: string
  "aria-label"?: string
  "aria-expanded"?: boolean
  onClick?: () => void
  /** Runs when the item is chosen; `preventDefault` keeps the menu open. */
  onSelect?: (event: Event) => void
}

/** An item's `onClick` and `onSelect` both run when it is chosen, by pointer or key, as Radix ran them. */
function useChoose({ onClick, onSelect }: Pick<MenuItemProps, "onClick" | "onSelect">) {
  const root = useMenuRoot()
  return () => {
    onClick?.()
    if (!onSelect) return
    const event = new Event("menu.itemSelect", { cancelable: true })
    onSelect(event)
    if (event.defaultPrevented) root.keepOpen()
  }
}

type LinkChild = React.ReactElement<
  { href?: string; target?: string; rel?: string; download?: boolean | string; children?: React.ReactNode; "aria-label"?: string }
>

/** The link an `asChild` item stands for: its `a` element's address and content. */
function linkOf(children: MenuItemProps["children"]) {
  const { href, target, rel, download, children: content, "aria-label": label } = (React.Children.only(children as React.ReactNode) as LinkChild).props
  return { link: { href, target, rel, download: download === true ? "" : download || undefined }, content, label }
}

/** Renders the item's element with the attributes React Aria's item has no prop for. */
function renderWith(extra: Record<string, string | boolean>) {
  if (!Object.keys(extra).length) return undefined
  return (props: React.HTMLAttributes<HTMLElement> & { href?: string }) => (props.href ? <a {...props} {...extra} /> : <div {...props} {...extra} />)
}

/** What a typeahead matches when the item names nothing else: its content, unless that is a function of the item's state. */
function staticText(content: MenuItemProps["children"]) {
  return typeof content === "function" ? "" : textOf(content)
}

/** The attributes React Aria's item has no prop for, collected from an item's props. */
function extraAttributes(props: ExtraAttributes) {
  const extra: Record<string, string | boolean> = {}
  for (const name of EXTRA_ATTRIBUTES) if (props[name] !== undefined) extra[name] = props[name]
  return extra
}

export function MenuItemPart({ slot, className, inset, variant = "default", disabled, asChild, textValue, onClick, onSelect, children, ...rest }: MenuItemProps & { slot: string }) {
  const choose = useChoose({ onClick, onSelect })
  const linked = asChild ? linkOf(children) : null
  const content = linked ? linked.content : children
  const label = rest["aria-label"] ?? linked?.label
  return (
    <MenuItem
      {...rest}
      {...linked?.link}
      aria-label={label}
      data-slot={slot}
      data-inset={inset || undefined}
      data-variant={variant}
      textValue={textValue ?? label ?? staticText(content)}
      isDisabled={disabled}
      onAction={choose}
      render={renderWith(extraAttributes(rest))}
      className={cn(ITEM_CLASS, className)}
    >
      {content}
    </MenuItem>
  )
}

/** A heading, or any note, toggle or message that sits among the items: React Aria's header, which
 *  takes any content and is not an item (arrow keys pass over it). */
export function MenuLabelPart({ slot, className, inset, children, ...rest }: { slot: string; className?: string; inset?: boolean; children?: React.ReactNode } & Omit<React.ComponentProps<"header">, "className" | "children">) {
  return (
    <MenuSection data-slot={slot} className="menu-section">
      <Header {...rest} data-inset={inset || undefined} className={cn("header px-2 py-1.5 text-sm font-medium data-[inset]:pl-8", className)}>
        {children}
      </Header>
    </MenuSection>
  )
}

export function MenuSeparatorPart({ slot, className, ...rest }: { slot: string; className?: string } & Omit<React.ComponentProps<typeof Separator>, "className">) {
  return <Separator {...rest} data-slot={slot} className={cn("separator -mx-1 my-1 h-px bg-border", className)} />
}

/** Items that belong together, named for assistive technology. */
export function MenuGroupPart({ slot, className, children, ...rest }: { slot: string; className?: string; children?: React.ReactNode } & Omit<React.ComponentProps<"section">, "className" | "children">) {
  return (
    <MenuSection {...rest} data-slot={slot} className={cn("menu-section", className)}>
      {children}
    </MenuSection>
  )
}

/** A submenu: its first child is the item that opens it, its second the content. */
export function MenuSubPart({ children }: { children: [React.ReactElement, React.ReactElement] }) {
  return <SubmenuTrigger>{children}</SubmenuTrigger>
}

const SUB_TRIGGER_CLASS = "gap-2 data-[open]:bg-[var(--fill-secondary)] data-[open]:text-[var(--text-primary)]"

export function MenuSubTriggerPart({ slot, className, children, ...props }: MenuItemProps & { slot: string }) {
  return (
    <MenuItemPart slot={slot} className={cn(SUB_TRIGGER_CLASS, className)} textValue={props.textValue ?? textOf(children as React.ReactNode)} {...props}>
      {children as React.ReactNode}
      <ChevronRightIcon className="ml-auto size-4" />
    </MenuItemPart>
  )
}

export function MenuSubContentPart({ slot, className, children, ...props }: OverlayDomProps & { slot: string; children?: React.ReactNode }) {
  return (
    <MenuSurface data-slot={slot} className={className} {...props}>
      <MenuList>{children}</MenuList>
    </MenuSurface>
  )
}

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
