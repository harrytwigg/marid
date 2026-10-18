import { lazy, Suspense, type ComponentProps } from "react"
import { LoadBoundary, LoadingScrim, useIdlePreload } from "@/components/ui/lazy-overlay"
import type { QuickCaptureBar as QuickCaptureBarComponent } from "./capture-bar"

/* The quick-capture bar (and the mic, pipeline strip and capture state behind
 * it) is not in the board's chunk: it loads when the page is idle, and when the
 * button that opens it is hovered, focused or touched, so a press normally finds
 * it loaded. A press before that still works: an inert scrim in the dialog's own
 * overlay stands in until the chunk lands. The bar is a modal over the page, not
 * part of its layout, so its arrival moves nothing. If the chunk cannot be
 * fetched the scrim is taken down and the caller is told. */

const load = () => import("./capture-bar")
const QuickCaptureBar = lazy(() => load().then((module) => ({ default: module.QuickCaptureBar })))

/** Starts the fetch; a failed one is reported to whoever opens the bar, not here. */
export function preloadQuickCapture(): void {
  void load().catch(() => {})
}

/** Fetches the bar once the page has settled, so the first press finds it loaded. */
export function usePreloadQuickCapture(): void {
  useIdlePreload(preloadQuickCapture)
}

export function LazyQuickCaptureBar({ onFailed, ...props }: ComponentProps<typeof QuickCaptureBarComponent> & { onFailed: () => void }) {
  return (
    <LoadBoundary onFailed={onFailed}>
      <Suspense fallback={<LoadingScrim testId="quick-capture-loading" />}>
        <QuickCaptureBar {...props} />
      </Suspense>
    </LoadBoundary>
  )
}
