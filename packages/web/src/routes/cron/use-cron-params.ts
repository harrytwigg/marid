import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import type { CronFilter } from "./shared"

/** Which of the page's two views is showing. */
export type CronLens = "jobs" | "week"

/**
 * The cron page's lens and job filter, held in the URL rather than in component
 * state, so the view is shareable and can be reached by a link — which is what
 * lets the Talk orb open "the disabled jobs" without reaching into the page.
 *
 * Both defaults are the absent param, and both setters replace rather than push
 * so the back button behaves exactly as it did when these were `useState`.
 */
export function useCronViewParams() {
  const [params, setParams] = useSearchParams()
  const lens: CronLens = params.get("lens") === "week" ? "week" : "jobs"
  const raw = params.get("filter")
  const filter: CronFilter = raw === "enabled" || raw === "disabled" ? raw : "all"

  const set = useCallback(
    (key: "lens" | "filter", value: string, isDefault: boolean) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (isDefault) next.delete(key)
          else next.set(key, value)
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const setLens = useCallback((next: CronLens) => set("lens", next, next === "jobs"), [set])
  const setFilter = useCallback((next: CronFilter) => set("filter", next, next === "all"), [set])

  return { lens, setLens, filter, setFilter }
}
