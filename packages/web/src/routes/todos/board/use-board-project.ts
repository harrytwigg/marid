import { useEffect, useRef } from "react"
import { setActiveProject, useActiveProject } from "@/hooks/use-active-project"

/* The board's project filter and the active project (the switcher's choice) are
 * one value. The store is the single source of truth: a URL that names a
 * project is adopted into it, and a change made elsewhere (the switcher, another
 * tab) is written back into a URL that still names the old one. */

/** The project filter the board shows: the URL's when it names one, otherwise the active project. */
export function useBoardProject(
  searchParams: URLSearchParams,
  setSearchParams: (next: URLSearchParams, opts?: { replace?: boolean }) => void,
  enabled: boolean,
): string | undefined {
  const active = useActiveProject()
  const urlProject = enabled ? searchParams.get("project")?.trim() || undefined : undefined
  // `url` starts empty so an arrival with a project in the URL is adopted.
  const seen = useRef<{ url: string | undefined; active: string | undefined }>({ url: undefined, active })

  useEffect(() => {
    const prev = seen.current
    seen.current = { url: urlProject, active }
    if (!enabled) return
    if (urlProject !== prev.url && urlProject && urlProject !== active) {
      setActiveProject(urlProject)
    } else if (active !== prev.active && urlProject && urlProject !== active) {
      const next = new URLSearchParams(searchParams)
      if (active) next.set("project", active)
      else next.delete("project")
      setSearchParams(next, { replace: true })
    }
  }, [enabled, urlProject, active, searchParams, setSearchParams])

  return enabled ? urlProject ?? active : undefined
}

/** Record a project chosen on the board's own chip as the active project. */
export function adoptBoardProject(next: string | undefined, current: string | undefined): void {
  if (next !== current) setActiveProject(next)
}
