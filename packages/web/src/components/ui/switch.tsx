import * as React from "react"

import { cn } from "@/lib/utils"
import { createLazyHeroUI } from "./heroui-lazy"

import type { HeroSwitch as HeroSwitchType } from "./switch-heroui"

const heroSwitch = createLazyHeroUI(() => import("./switch-heroui"))

type SwitchProps = Omit<React.ComponentProps<"button">, "onChange" | "value" | "type"> & {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  required?: boolean
  name?: string
  value?: string
  /**
   * The press target: the whole area that toggles the switch, drawn around the
   * track. Defaults to the track's own size. A call site that needs a bigger
   * hit area than the control looks asks for it here, not by wrapping.
   */
  targetClassName?: string
}

/**
 * Same shape as ever (`checked`, `onCheckedChange`), drawn by HeroUI's Switch.
 * The input underneath is a native checkbox with role=switch, so the checked
 * state is `checked`, not `aria-checked`, and a form can submit it by `name`.
 */
function Switch({ checked, defaultChecked, onCheckedChange, ...props }: SwitchProps) {
  const hero = heroSwitch.use()
  const [uncontrolled, setUncontrolled] = React.useState(defaultChecked ?? false)
  const selected = checked ?? uncontrolled
  const change = (next: boolean) => {
    setUncontrolled(next)
    onCheckedChange?.(next)
  }
  const shared = { ...props, selected, change }
  return hero ? <LoadedSwitch hero={hero.HeroSwitch} {...shared} /> : <PlainSwitch {...shared} />
}

type ViewProps = Omit<SwitchProps, "onCheckedChange" | "checked" | "defaultChecked"> & {
  selected: boolean
  change: (next: boolean) => void
}

function LoadedSwitch({
  hero: Hero,
  selected,
  change,
  disabled,
  required,
  name,
  value,
  id,
  className,
  targetClassName,
  ...rest
}: ViewProps & { hero: typeof HeroSwitchType }) {
  const { aria, data, onClick } = splitProps(rest)
  return (
    <Hero
      data-slot="switch"
      // `isSelected` is held here for both kinds of switch, so one that was
      // given a defaultChecked still keeps its state across the swap.
      isSelected={selected}
      onChange={change}
      isDisabled={disabled}
      isRequired={required}
      name={name}
      value={value}
      size="lg"
      id={id}
      className={cn("shrink-0", className)}
      onClick={onClick as never}
      {...aria}
      {...data}
    >
      <Hero.Content className={targetClassName}>
        <Hero.Control>
          <Hero.Thumb />
        </Hero.Control>
      </Hero.Content>
    </Hero>
  )
}

/** Not loaded yet: the same markup, from plain elements, in HeroUI's classes. */
function PlainSwitch({
  selected,
  change,
  disabled,
  required,
  name,
  value,
  id,
  className,
  targetClassName,
  ...rest
}: ViewProps) {
  const { aria, data, onClick } = splitProps(rest)
  return (
    <div
      data-slot="switch"
      className={cn("switch switch--lg shrink-0", className)}
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      onClick={onClick}
      {...data}
    >
      <label data-slot="switch-content" className={cn("switch__content", targetClassName)}>
        <input
          {...aria}
          id={id}
          type="checkbox"
          role="switch"
          className="sr-only"
          checked={selected}
          disabled={disabled}
          required={required}
          name={name}
          value={value}
          onChange={(event) => change(event.target.checked)}
        />
        <span data-slot="switch-control" className="switch__control">
          <span data-slot="switch-thumb" className="switch__thumb" />
        </span>
      </label>
    </div>
  )
}

/**
 * The accessible name and description belong on the input; the data attributes
 * and a click handler on the root, which is where a click inside the control
 * (the label, the track, the input itself) ends up after it bubbles.
 */
function splitProps(props: Record<string, unknown>) {
  const aria: Record<string, unknown> = {}
  const data: Record<string, unknown> = {}
  for (const key of Object.keys(props)) {
    if (key.startsWith("aria-")) aria[key] = props[key]
    else if (key.startsWith("data-")) data[key] = props[key]
  }
  return { aria, data, onClick: props.onClick as React.MouseEventHandler<HTMLElement> | undefined }
}

export { Switch }
