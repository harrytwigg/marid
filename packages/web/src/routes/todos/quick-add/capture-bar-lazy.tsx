import { lazy, Suspense, type ComponentProps } from "react"
import type { QuickCaptureBar as QuickCaptureBarComponent } from "./capture-bar"

/* The quick-capture bar (and the mic, pipeline strip and capture state behind
 * it) is mounted only after someone asks for it, so it loads on first use
 * instead of riding in the board's chunk. */

const QuickCaptureBar = lazy(() => import("./capture-bar").then((module) => ({ default: module.QuickCaptureBar })))

export function LazyQuickCaptureBar(props: ComponentProps<typeof QuickCaptureBarComponent>) {
  return (
    <Suspense fallback={null}>
      <QuickCaptureBar {...props} />
    </Suspense>
  )
}
