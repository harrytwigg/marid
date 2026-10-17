import * as React from "react"

import { cn } from "@/lib/utils"

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
