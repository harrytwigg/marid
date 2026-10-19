import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as HeroTabs } from "@heroui/react/tabs"

import { cn } from "@/lib/utils"

/**
 * Same parts and props as ever (`value`, `onValueChange`, a trigger and its
 * content paired by `value`), drawn by HeroUI's Tabs: the value is a React Aria
 * key, a trigger is a Tab, content is a Panel, and the arrow keys, Home and End
 * move between triggers. `default` is HeroUI's pill list, `line` its underline.
 * Tabs keep React Aria (a native element has no roving arrow-key behaviour), so
 * a route that renders them carries it.
 *
 * What a plugin author can rely on is what the types below name, which is what
 * the SDK declares: class, children, style, `aria-label`, `value`, `disabled`.
 * Against the Radix tabs this replaces: React Aria filters the DOM props it does
 * not know, so a `title` on a trigger or a key handler on the list does nothing,
 * and `activationMode`, `dir`, `asChild` and a content's `forceMount` are gone;
 * and with no `defaultValue` the first tab is selected and its panel shown,
 * where Radix showed none.
 */
type Shared = Pick<React.ComponentProps<"div">, "className" | "children" | "style" | "aria-label">
type Orientation = "horizontal" | "vertical"
type ListVariant = "default" | "line"

const tabsListVariants = cva("tabs__list", {
  variants: {
    variant: {
      default: "",
      line: "",
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

interface TabsState {
  orientation: Orientation
  variant: ListVariant
  setVariant: (variant: ListVariant) => void
}

/**
 * HeroUI's Tabs reads the variant off its root, while this API gives it to the
 * list, so the list says which one it is and the root restyles itself.
 */
const TabsContext = React.createContext<TabsState | null>(null)

type TabsProps = Pick<Shared, "className" | "children" | "style"> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  orientation?: Orientation
}

function Tabs({ value, defaultValue, onValueChange, orientation = "horizontal", children, ...props }: TabsProps) {
  const [variant, setVariant] = React.useState<ListVariant>("default")
  const state = React.useMemo<TabsState>(() => ({ orientation, variant, setVariant }), [orientation, variant])
  const Root = HeroTabs as unknown as React.ComponentType<Record<string, unknown>>
  return (
    <TabsContext.Provider value={state}>
      <Root
        data-slot="tabs"
        orientation={orientation}
        variant={variant === "line" ? "secondary" : "primary"}
        {...(value === undefined ? { defaultSelectedKey: defaultValue } : { selectedKey: value })}
        onSelectionChange={(key: React.Key) => onValueChange?.(String(key))}
        {...props}
      >
        {children}
      </Root>
    </TabsContext.Provider>
  )
}

function useTabsState() {
  const state = React.useContext(TabsContext)
  if (!state) throw new Error("Tabs parts must be rendered inside <Tabs>")
  return state
}

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: Shared & VariantProps<typeof tabsListVariants>) {
  const { setVariant } = useTabsState()
  const v: ListVariant = variant ?? "default"
  React.useLayoutEffect(() => setVariant(v), [setVariant, v])
  return (
    <HeroTabs.ListContainer>
      <HeroTabs.List data-slot="tabs-list" data-variant={v} className={className} {...(props as Record<string, unknown>)}>
        {children as React.ReactNode}
      </HeroTabs.List>
    </HeroTabs.ListContainer>
  )
}

function TabsTrigger({
  className,
  value,
  disabled,
  children,
  onClick,
  ...props
}: Pick<Shared, "className" | "children" | "style" | "aria-label"> & {
  value: string
  disabled?: boolean
  onClick?: React.MouseEventHandler<HTMLElement>
}) {
  return (
    <HeroTabs.Tab
      data-slot="tabs-trigger"
      id={value}
      isDisabled={disabled}
      className={className}
      onClick={onClick as never}
      {...(props as Record<string, unknown>)}
    >
      {children}
      <HeroTabs.Indicator />
    </HeroTabs.Tab>
  )
}

function TabsContent({
  className,
  value,
  children,
  ...props
}: Pick<Shared, "className" | "children" | "style"> & { value: string }) {
  return (
    <HeroTabs.Panel data-slot="tabs-content" id={value} className={cn("flex-1 outline-none", className)} {...(props as Record<string, unknown>)}>
      {children}
    </HeroTabs.Panel>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
