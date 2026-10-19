import { cn } from "@/lib/utils"

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: number | string
  height?: number | string
}

/**
 * HeroUI's skeleton, as a native element in its `skeleton` classes (the default
 * shimmer). HeroUI's own component adds nothing a div needs, and importing it
 * puts its class-variant and React Aria SSR helpers, about 14 KB gzip, into
 * every route that shows a skeleton.
 */
function Skeleton({ className, width, height, style, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton skeleton--shimmer rounded-md", className)}
      style={{ width, height, ...style }}
      {...props}
    />
  )
}

export { Skeleton }
