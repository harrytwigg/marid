import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "./slot"

import { cn } from "@/lib/utils"

/**
 * The button's look is HeroUI's: the `button` classes (variant and size) come
 * from its stylesheet, and the Aero material is layered on in heroui-glass.css.
 * It is a native element. HeroUI's stylesheet answers `:hover`, `:active`,
 * `:focus-visible` and `:disabled` beside its `data-*` forms, so the control
 * needs none of React Aria's press handling, and every prop a button takes
 * (title, role, tabIndex, pointer and mouse handlers, ref) reaches the element
 * untouched. What is left here is the mapping from this app's variant and size
 * names, and the few sizes HeroUI has no name for.
 */
const HERO_VARIANT = {
  default: "primary",
  destructive: "danger",
  outline: "outline",
  secondary: "secondary",
  ghost: "ghost",
  link: "ghost",
} as const

const HERO_SIZE = {
  default: "md",
  xs: "sm",
  sm: "sm",
  lg: "lg",
  icon: "md",
  "icon-xs": "sm",
  "icon-sm": "sm",
  "icon-lg": "lg",
} as const

type Variant = keyof typeof HERO_VARIANT
type Size = keyof typeof HERO_SIZE

const isIconSize = (size: Size) => size.startsWith("icon")

/** What HeroUI's own variant classes do not already say. */
const buttonExtras = cva(
  "shrink-0 gap-2 text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: "",
        destructive: "",
        outline: "",
        secondary: "",
        ghost: "",
        link: "text-[var(--accent)] underline-offset-4 hover:bg-transparent hover:underline data-[hovered=true]:bg-transparent data-[pressed=true]:bg-transparent",
      },
      size: {
        default: "",
        xs: "h-6 gap-1 px-2 text-xs md:h-6 [&_svg:not([class*='size-'])]:size-3",
        sm: "",
        lg: "",
        icon: "",
        "icon-xs": "size-6 md:size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "",
        "icon-lg": "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** The class list a plain element needs to look like this button. */
function nativeClassName(variant: Variant, size: Size, className?: string) {
  return cn(
    "button",
    `button--${HERO_SIZE[size]}`,
    `button--${HERO_VARIANT[variant]}`,
    isIconSize(size) && "button--icon-only",
    buttonExtras({ variant, size }),
    className,
  )
}

/** The class list for anything that should look like a button (a link, a slotted child). */
function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: VariantProps<typeof buttonExtras> & { className?: string } = {}) {
  return nativeClassName(variant ?? "default", size ?? "default", className)
}

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonExtras> & {
    asChild?: boolean
  }

function Button({ className, variant = "default", size = "default", asChild = false, ...props }: ButtonProps) {
  const v: Variant = variant ?? "default"
  const s: Size = size ?? "default"
  const Comp = asChild ? Slot : "button"
  return <Comp data-slot="button" data-variant={v} data-size={s} className={nativeClassName(v, s, className)} {...props} />
}

export { Button, buttonVariants }
