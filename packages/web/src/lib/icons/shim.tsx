import * as React from "react"
import type { Icon as PhosphorIcon } from "@phosphor-icons/react"

type ShimProps = Omit<React.SVGProps<SVGSVGElement>, "ref"> & {
  size?: number | string
  color?: string
  strokeWidth?: number | string
  absoluteStrokeWidth?: boolean
}

/** A Phosphor glyph that takes Lucide's props. Lucide draws 24px unless told
 *  otherwise and takes stroke props Phosphor has no use for; those are dropped
 *  so they never reach the DOM. */
export function shim(Glyph: PhosphorIcon, name: string) {
  const Shimmed = React.forwardRef<SVGSVGElement, ShimProps>(function Shimmed(
    { size = 24, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, ...rest },
    ref,
  ) {
    return <Glyph ref={ref} size={size} weight="duotone" {...rest} />
  })
  Shimmed.displayName = name
  return Shimmed
}
