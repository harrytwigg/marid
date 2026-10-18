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
