import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A panel that scrolls what overflows its height, with the app's own scrollbar: the browser's native scrolling
 * (momentum, keyboard, find-in-page and scroll anchoring all stay the browser's), and a bar that rests invisible
 * and shows while the pointer or focus is in the area, which keeps a scrollable panel from reading as a bordered
 * box at rest. The bar's drawing is `.scroll-area` in `routes/globals.css`. Takes the props of a `div`; give it a height.
 */
function ScrollArea({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="scroll-area"
      className={cn(
        "scroll-area relative overflow-auto rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)]",
        className
      )}
      {...props}
    />
  )
}

export { ScrollArea }
