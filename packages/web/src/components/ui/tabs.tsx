import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { createLazyHeroUI } from "./heroui-lazy"

/**
 * Same parts and props as ever (`value`, `onValueChange`, a trigger and its
 * content paired by `value`), drawn by HeroUI's Tabs: the value is a React Aria
 * key, a trigger is a Tab, content is a Panel, and the arrow keys, Home and End
 * move between triggers. `default` is HeroUI's pill list, `line` its underline.
 */
import type { HeroTabs as HeroTabsType } from "./tabs-heroui"

const heroTabs = createLazyHeroUI(() => import("./tabs-heroui"))

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
  value: string | undefined
  select: (value: string) => void
  orientation: Orientation
  variant: ListVariant
  setVariant: (variant: ListVariant) => void
}

/**
 * The plain-element tabs keep their selection here. HeroUI's Tabs reads the
 * variant off its root, while this API gives it to the list, so the list says
 * which one it is, and the root restyles itself.
 */
const FallbackContext = React.createContext<TabsState | null>(null)

type TabsProps = Omit<React.ComponentProps<"div">, "defaultValue" | "onChange"> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  orientation?: Orientation
}

function Tabs({ value, defaultValue, onValueChange, orientation = "horizontal", ...props }: TabsProps) {
  const hero = heroTabs.use()
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue)
  const [variant, setVariant] = React.useState<ListVariant>("default")
  const selected = value ?? uncontrolled
  const state = React.useMemo<TabsState>(
    () => ({
      value: selected,
      select: (next) => {
        setUncontrolled(next)
        onValueChange?.(next)
      },
      orientation,
      variant,
      setVariant,
    }),
    [selected, onValueChange, orientation, variant],
  )
  return (
    <FallbackContext.Provider value={state}>
      {hero ? <LoadedTabs hero={hero.HeroTabs} state={state} {...props} /> : <PlainTabs state={state} {...props} />}
    </FallbackContext.Provider>
  )
}

type RootProps = Omit<React.ComponentProps<"div">, "defaultValue" | "onChange"> & { state: TabsState }

function LoadedTabs({ hero, state, children, ...props }: RootProps & { hero: typeof HeroTabsType }) {
  const Hero = hero as unknown as React.ComponentType<Record<string, unknown>>
  return (
    <Hero
      data-slot="tabs"
      orientation={state.orientation}
      variant={state.variant === "line" ? "secondary" : "primary"}
      // Always controlled from here, so a selection made before React Aria
      // loaded is still the selection after it has.
      selectedKey={state.value}
      onSelectionChange={(key: React.Key) => state.select(String(key))}
      {...props}
    >
      {children}
    </Hero>
  )
}

function PlainTabs({ state, className, children, ...props }: RootProps) {
  return (
    <div
      data-slot="tabs"
      data-orientation={state.orientation}
      className={cn("tabs", state.variant === "line" && "tabs--secondary", className)}
      {...props}
    >
      {children}
    </div>
  )
}

function useTabsState() {
  const state = React.useContext(FallbackContext)
  if (!state) throw new Error("Tabs parts must be rendered inside <Tabs>")
  return state
}

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof tabsListVariants>) {
  const hero = heroTabs.use()
  const state = useTabsState()
  const v: ListVariant = variant ?? "default"
  const { setVariant } = state
  React.useLayoutEffect(() => setVariant(v), [setVariant, v])

  if (hero) {
    const Hero = hero.HeroTabs
    return (
      <Hero.ListContainer>
        <Hero.List data-slot="tabs-list" data-variant={v} className={className} {...(props as Record<string, unknown>)}>
          {children as React.ReactNode}
        </Hero.List>
      </Hero.ListContainer>
    )
  }
  return (
    <div className="tabs__list-container">
      <div
        role="tablist"
        aria-orientation={state.orientation}
        data-slot="tabs-list"
        data-variant={v}
        data-orientation={state.orientation}
        className={cn("tabs__list", className)}
        {...props}
      >
        {children}
      </div>
    </div>
  )
}

function TabsTrigger({
  className,
  value,
  disabled,
  children,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "value"> & { value: string }) {
  const hero = heroTabs.use()
  const state = useTabsState()

  if (hero) {
    const Hero = hero.HeroTabs
    return (
      <Hero.Tab
        data-slot="tabs-trigger"
        id={value}
        isDisabled={disabled}
        className={className}
        onClick={onClick as never}
        {...(props as Record<string, unknown>)}
      >
        {children}
        <Hero.Indicator />
      </Hero.Tab>
    )
  }
  const selected = state.value === value
  return (
    <button
      type="button"
      role="tab"
      data-slot="tabs-trigger"
      aria-selected={selected}
      data-selected={selected || undefined}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={cn("tabs__tab", className)}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) state.select(value)
      }}
      {...props}
    >
      {children}
    </button>
  )
}

function TabsContent({
  className,
  value,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & { value: string; children?: React.ReactNode }) {
  const hero = heroTabs.use()
  const state = useTabsState()

  if (hero) {
    const Hero = hero.HeroTabs
    return (
      <Hero.Panel data-slot="tabs-content" id={value} className={cn("flex-1 outline-none", className)} {...(props as Record<string, unknown>)}>
        {children}
      </Hero.Panel>
    )
  }
  if (state.value !== value) return null
  return (
    <div role="tabpanel" data-slot="tabs-content" className={cn("tabs__panel flex-1 outline-none", className)} {...props}>
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
