import { Skeleton as HeroSkeleton } from "@heroui/react/skeleton"

import { cn } from "@/lib/utils"

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: number | string
  height?: number | string
}

function Skeleton({ className, width, height, style, ...props }: SkeletonProps) {
  return (
    <HeroSkeleton
      data-slot="skeleton"
      className={cn("rounded-md", className)}
      style={{ width, height, ...style }}
      {...props}
    />
  )
}

export { Skeleton }
