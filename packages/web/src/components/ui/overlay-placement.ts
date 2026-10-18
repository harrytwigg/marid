import type * as React from "react"
import type { Placement } from "react-aria"

export type Side = "top" | "right" | "bottom" | "left"
export type Align = "start" | "center" | "end"

/** The overlay adapters take Radix's `side` and `align`; React Aria takes one
 *  placement. Along a vertical edge `start` and `end` are the leading and
 *  trailing edges; along a horizontal one they are the top and the bottom. */
export function placementOf(side: Side, align: Align): Placement {
  if (align === "center") return side
  if (side === "top" || side === "bottom") return `${side} ${align}`
  return `${side} ${align === "start" ? "top" : "bottom"}`
}

/** The DOM props React Aria's overlay surfaces pass on: an id, `data-*`, and the
 *  mouse, pointer and touch handlers. Anything else (`onKeyDown`, `onFocus`,
 *  `title`, `role`, `style`) it drops without a word, so the content parts type
 *  only these and a caller cannot pass what would silently do nothing. */
export type OverlayDomProps = Pick<
  React.ComponentProps<"div">,
  | "id"
  | "className"
  | "onClick"
  | "onMouseDown"
  | "onMouseUp"
  | "onMouseEnter"
  | "onMouseLeave"
  | "onMouseMove"
  | "onPointerDown"
  | "onPointerUp"
  | "onPointerMove"
  | "onTouchStart"
  | "onTouchEnd"
  | "onTouchMove"
>
