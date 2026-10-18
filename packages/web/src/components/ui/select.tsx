import * as React from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { Button } from "react-aria-components/Button"
import { Header } from "react-aria-components/Header"
import { ListBox, ListBoxItem, ListBoxSection } from "react-aria-components/ListBox"
import { Popover } from "react-aria-components/Popover"
import { Select as AriaSelect, SelectValue as AriaSelectValue } from "react-aria-components/Select"
import { Separator } from "react-aria-components/Separator"

import { cn } from "@/lib/utils"
import { MENU_SURFACE_ATTR, textOf } from "./menu-parts"
import { returnFocusTo } from "./menu-focus"

/**
 * A select over React Aria's Select, ListBox and Popover in HeroUI's `select`,
 * `list-box` and `list-box-item` classes (not its components, which add a
 * variants runtime for the same markup), under the parts and props the Radix
 * select had. The trigger is a `combobox` that names its list; the list opens on
 * a press or ArrowDown/ArrowUp and closes on Escape, a press outside, or a
 * choice, and focus goes back to the trigger. Typing a letter on the trigger or
 * in the list moves to the next item that starts with it.
 *
 * Items are matched by `value`, which must be a non-empty string. An item's
 * typeahead text is what it says (React Aria reads only a string child).
 *
 * Not carried over from the Radix select: `position="item-aligned"` (the list
 * always sits below or above the trigger) and the scroll buttons (the list
 * scrolls natively), neither of which anything used.
 */

type SelectProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  name?: string
  required?: boolean
  children?: React.ReactNode
}

/** The name the trigger was given, which React Aria wants on the select that owns it. */
function triggerLabel(children: React.ReactNode): string | undefined {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement(child)) continue
    const props = child.props as { "aria-label"?: string }
    if (child.type === SelectTrigger && props["aria-label"]) return props["aria-label"]
  }
  return undefined
}

function Select({ value, defaultValue, onValueChange, disabled, name, required, children }: SelectProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  return (
    <AriaSelect
      ref={ref}
      // React Aria puts focus back on the trigger, but not when a modal holding focus got there first (see `returnFocusTo`).
      onOpenChange={(open) => {
        if (!open) returnFocusTo(ref.current?.querySelector<HTMLElement>("[data-slot=select-trigger]") ?? null)
      }}
      data-slot="select"
      className="select w-full"
      selectedKey={value}
      defaultSelectedKey={defaultValue}
      onSelectionChange={(key) => {
        if (key !== null) onValueChange?.(String(key))
      }}
      isDisabled={disabled}
      isRequired={required}
      name={name}
      aria-label={triggerLabel(children)}
    >
      {children}
    </AriaSelect>
  )
}

function SelectGroup({ className, children, ...props }: Omit<React.ComponentProps<typeof ListBoxSection>, "className"> & { className?: string }) {
  return (
    <ListBoxSection data-slot="select-group" className={cn("list-box-section", className)} {...props}>
      {children}
    </ListBoxSection>
  )
}

function SelectValue({ placeholder, className }: { placeholder?: React.ReactNode; className?: string }) {
  return (
    <AriaSelectValue data-slot="select-value" className={cn("select__value truncate", className)}>
      {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? (placeholder ?? defaultChildren) : defaultChildren)}
    </AriaSelectValue>
  )
}

function SelectTrigger({
  className,
  children,
  "aria-label": ariaLabel,
  disabled,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "className" | "children" | "isDisabled"> & { className?: string; children?: React.ReactNode; disabled?: boolean }) {
  return (
    <Button
      data-slot="select-trigger"
      aria-label={ariaLabel}
      // React Aria's trigger is a plain button; the Radix one was a combobox, which assistive technology and tests
      // name by `aria-label`, so the label is the name and the value is read from the content, as before.
      render={(domProps) => <button {...domProps} role="combobox" aria-labelledby={ariaLabel ? undefined : domProps["aria-labelledby"]} />}
      isDisabled={disabled}
      className={cn("select__trigger w-full items-center justify-between gap-[var(--space-2)] text-[length:var(--text-footnote)]", className)}
      {...props}
    >
      {children}
      <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
    </Button>
  )
}

function SelectContent({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <Popover
      data-slot="select-content"
      // Marks the list as a surface that is leaving, so focus is returned once it has gone (see `returnFocusTo`).
      {...{ [MENU_SURFACE_ATTR]: "" }}
      offset={4}
      containerPadding={8}
      className={cn("select__popover glass-overlay", className)}
    >
      <ListBox className="list-box outline-none" data-slot="list-box">
        {children}
      </ListBox>
    </Popover>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <Header
      data-slot="select-label"
      className={cn("px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  value,
  disabled,
  textValue,
}: {
  className?: string
  children?: React.ReactNode
  value: string
  disabled?: boolean
  textValue?: string
}) {
  return (
    <ListBoxItem
      id={value}
      data-slot="select-item"
      textValue={textValue ?? textOf(children)}
      isDisabled={disabled}
      className={cn(
        "list-box-item group text-[length:var(--text-footnote)] data-[focused]:bg-[var(--fill-secondary)] data-[selected]:text-[var(--accent)]",
        className,
      )}
    >
      {children}
      {/* Shown for the selected item only: in the trigger's value there is no selected ancestor, so it stays hidden. */}
      <CheckIcon aria-hidden className="ml-auto hidden size-4 shrink-0 text-[var(--accent)] group-data-[selected]:block" />
    </ListBoxItem>
  )
}

function SelectSeparator({ className, ...props }: Omit<React.ComponentProps<typeof Separator>, "className"> & { className?: string }) {
  return <Separator data-slot="select-separator" className={cn("separator -mx-[var(--space-1)] my-[var(--space-1)] h-px bg-[var(--separator)]", className)} {...props} />
}

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator }
