import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Chip } from "@heroui/react/chip"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * A small status label, drawn by HeroUI's Chip.
 *
 * The tinted variants are the app's existing chip recipe: the colour at 12%
 * for the fill and at full strength for the text, which is HeroUI's `soft`
 * variant. No border at rest: the fill is the separation.
 */
const CHIP = {
  default: { color: "default", variant: "soft" },
  secondary: { color: "default", variant: "tertiary" },
  success: { color: "success", variant: "soft" },
  warning: { color: "warning", variant: "soft" },
  destructive: { color: "danger", variant: "soft" },
} as const

const badgeVariants = cva(
  "w-fit shrink-0 whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: "",
        secondary: "",
        success: "",
        warning: "",
        destructive: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }) {
  const v = variant ?? "default"
  const { color, variant: chipVariant } = CHIP[v]
  const marks = { "data-slot": "badge", "data-variant": v }

  if (asChild) {
    // A child that is already an element (a link, say) takes HeroUI's classes
    // as they are, since a Chip would add a span around it.
    return (
      <Slot.Root
        {...marks}
        className={cn("chip", "chip--sm", `chip--${color}`, `chip--${chipVariant}`, badgeVariants({ variant: v }), className)}
        {...props}
      >
        {children}
      </Slot.Root>
    )
  }
  return (
    <Chip {...props} {...marks} size="sm" color={color} variant={chipVariant} className={cn(badgeVariants({ variant: v }), className)}>
      {children}
    </Chip>
  )
}

export { Badge, badgeVariants }
