import { Component, useEffect, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { reportLoadFailure } from "@/lib/report-load-failure"

/* The parts a lazily loaded modal (the quick-capture bar, the new-Todo dialog, the filter sheet, the sprint planner) shares. Each is a separate chunk that
 * loads when the page is idle and when the button that opens it is hovered, focused or touched, so a press normally
 * finds it loaded. A press before that still works: an inert scrim in the dialog's own overlay stands in until the
 * chunk lands, and if the chunk cannot be fetched the scrim is taken down and the caller is told. */

/** Calls `preload` once the page has settled, so the first press finds the chunk loaded. */
export function useIdlePreload(preload: () => void): void {
  useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(preload)
      return () => cancelIdleCallback(handle)
    }
    const timer = window.setTimeout(preload, 1500)
    return () => window.clearTimeout(timer)
  }, [preload])
}

/** Stands where the dialog will be: the scrim, which takes no press, so the page behind keeps working. */
export function LoadingScrim({ testId, className }: { testId: string; className?: string }) {
  return (
    <div
      aria-hidden
      data-testid={testId}
      className={cn("pointer-events-none fixed inset-0 z-50 bg-[var(--scrim)] motion-safe:animate-overlay-in md:bg-transparent", className)}
    />
  )
}

/** When the chunk it waits for throws (a stale chunk after a deploy, or offline): says so on the app's notice surface,
 *  under `what` ("Quick capture", "The filter sheet"), and tells the caller, once, so it can close the overlay. */
export class LoadBoundary extends Component<{ what: string; onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    reportLoadFailure(this.props.what)
    this.props.onFailed()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}
