import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { createLazyHeroUI } from "./heroui-lazy"

/**
 * The button's look is HeroUI's: the `button` classes (variant and size) come
 * from its stylesheet, and the Aero material is layered on in heroui-glass.css.
 * What is left here is the mapping from this app's variant and size names, and
 * the few sizes HeroUI has no name for.
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

const heroButton = createLazyHeroUI(() => import("./button-heroui"))

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonExtras> & {
    asChild?: boolean
  }

/**
 * React Aria's Button forwards only the DOM props it knows, and these are three
 * a button here has always carried. They are written onto the element instead.
 */
function useKeptAttributes(
  ref: React.Ref<HTMLButtonElement> | undefined,
  { title, role, tabIndex }: Pick<React.ComponentProps<"button">, "title" | "role" | "tabIndex">,
) {
  const node = React.useRef<HTMLButtonElement | null>(null)
  const setRef = React.useCallback(
    (element: HTMLButtonElement | null) => {
      node.current = element
      if (typeof ref === "function") ref(element)
      else if (ref) ref.current = element
    },
    [ref],
  )
  React.useLayoutEffect(() => {
    const element = node.current
    if (!element) return
    if (title !== undefined) element.title = title
    if (role !== undefined) element.setAttribute("role", role)
    if (tabIndex !== undefined) element.tabIndex = tabIndex
  })
  return setRef
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  disabled,
  type = "submit",
  ref,
  ...props
}: ButtonProps) {
  const hero = heroButton.use()
  const kept = useKeptAttributes(ref, props)
  const v: Variant = variant ?? "default"
  const s: Size = size ?? "default"
  const marks = { "data-slot": "button", "data-variant": v, "data-size": s }

  if (asChild) {
    return <Slot.Root {...marks} ref={ref} className={nativeClassName(v, s, className)} {...props} />
  }
  if (hero) {
    const Hero = hero.HeroButton as React.ComponentType<Record<string, unknown>>
    return (
      <Hero
        {...marks}
        variant={HERO_VARIANT[v]}
        size={HERO_SIZE[s]}
        isIconOnly={isIconSize(s)}
        isDisabled={disabled}
        type={type}
        ref={kept}
        className={cn(buttonExtras({ variant: v, size: s }), className)}
        {...props}
      />
    )
  }
  return <button {...marks} ref={ref} type={type} disabled={disabled} className={nativeClassName(v, s, className)} {...props} />
}

export { Button, buttonVariants }
