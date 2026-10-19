import * as React from "react"

import { cn } from "@/lib/utils"

/** A multi-line text field in HeroUI's `textarea` classes. A native element, for the reason Input is. */
function Textarea({
  className,
  rows = 4,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn("textarea textarea--primary flex w-full resize-y text-[length:var(--text-footnote)]", className)}
      {...props}
    />
  )
}

export { Textarea }
