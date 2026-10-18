import * as React from "react"

import { cn } from "@/lib/utils"

type SwitchProps = Omit<React.ComponentProps<"div">, "onChange" | "defaultValue"> & {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
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
 * Same shape as ever (`checked`, `onCheckedChange`), in HeroUI's switch markup
 * and classes. The input is a native checkbox with role=switch, so the checked
 * state is `checked`, not `aria-checked`, and a form can submit it by `name`.
 * HeroUI's stylesheet keys the track on `data-selected` and `data-disabled` at
 * the root and answers `:hover` and `:active` itself; the focus ring is drawn
 * from the input's `:focus-visible` in heroui-glass.css.
 */
function Switch({
  className,
  targetClassName,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  required,
  name,
  value,
  id,
  ...rest
}: SwitchProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultChecked ?? false)
  const selected = checked ?? uncontrolled
  const { aria, root } = splitProps(rest)
  return (
    <div
      data-slot="switch"
      className={cn("switch switch--lg shrink-0", className)}
      data-selected={selected || undefined}
      data-disabled={disabled || undefined}
      {...root}
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
          onChange={(event) => {
            setUncontrolled(event.target.checked)
            onCheckedChange?.(event.target.checked)
          }}
        />
        <span data-slot="switch-control" className="switch__control">
          <span data-slot="switch-thumb" className="switch__thumb" />
        </span>
      </label>
    </div>
  )
}

/**
 * The accessible name and description (aria-*) belong on the input. Everything
 * else a caller passes (data attributes, title, style, a click handler) goes on
 * the root, which is where a click inside the control (the label, the track,
 * the input itself) ends up after it bubbles.
 */
function splitProps(props: Record<string, unknown>) {
  const aria: Record<string, unknown> = {}
  const root: Record<string, unknown> = {}
  for (const key of Object.keys(props)) {
    if (key.startsWith("aria-")) aria[key] = props[key]
    else root[key] = props[key]
  }
  return { aria, root }
}

export { Switch }
