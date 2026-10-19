import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "./slot"

import { cn } from "@/lib/utils"

/**
 * A small status label in HeroUI's `chip` classes. A native span: a Chip has no
 * behaviour, and its component would pull class-variant helpers into the SDK chunk.
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
  const Comp = asChild ? Slot : "span"
  // As HeroUI's Chip does, a bare string or number gets its label wrapper.
  const label = typeof children === "string" || typeof children === "number" ? <span className="chip__label">{children}</span> : children

  return (
    <Comp
      data-slot="badge"
      data-variant={v}
      className={cn("chip", "chip--sm", `chip--${color}`, `chip--${chipVariant}`, badgeVariants({ variant: v }), className)}
      {...props}
    >
      {asChild ? children : label}
    </Comp>
  )
}

export { Badge, badgeVariants }
