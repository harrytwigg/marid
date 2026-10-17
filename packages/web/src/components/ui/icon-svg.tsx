import type * as React from "react"

/**
 * What every icon accepts: the SVG props, a `size` (24 unless told otherwise)
 * and a `color`. There is no stroke weight, because Phosphor's weights are
 * separate drawings and the app draws every icon in duotone; `filled` raises
 * the 20% layer to full strength for the places Lucide's `fill` marked a state
 * or drew a solid dot.
 */
export type IconProps = Omit<React.ComponentProps<"svg">, "strokeWidth"> & {
  size?: number | string
  color?: string
  filled?: boolean
}

/** The type of an icon component, for a table or prop that holds one. */
export type IconComponent = (props: IconProps) => React.ReactElement

interface IconSvgProps extends IconProps {
  /** The name the app imports the icon by; written to `data-icon`. */
  name: string
  /** Path data of the 20% fill layer. */
  layer: string
  /** Path data of the outline. */
  line: string
}

/** The shared markup of a generated icon (see `icons/`). Decorative unless the
 *  caller labels it, as Lucide's icons were. */
export function IconSvg({ name, layer, line, size = 24, color, filled = false, ...props }: IconSvgProps) {
  const labelled = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill={color ?? "currentColor"}
      aria-hidden={labelled ? undefined : true}
      data-icon={name}
      {...props}
    >
      <path d={layer} opacity={filled ? 1 : 0.2} />
      <path d={line} />
    </svg>
  )
}
