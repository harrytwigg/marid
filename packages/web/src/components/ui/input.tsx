import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A single-line text field in HeroUI's `input` classes.
 *
 * It stays a native input. A text field that swapped for another element when
 * React Aria finished loading would drop the caret from a field the user had
 * already clicked into, and everything React Aria's Input adds (hover, focus,
 * disabled and invalid state) HeroUI's stylesheet also reads from the
 * element's own pseudo-classes and `aria-invalid`.
 *
 * Separation is a fill rather than a hairline: at rest the field is a tinted
 * well on its surface, and focus deepens the fill and adds the accent ring. 34px
 * is the floor so the field is a comfortable target on a phone.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn("input input--primary flex h-[34px] w-full text-[length:var(--text-footnote)]", className)}
      {...props}
    />
  )
}

export { Input }
