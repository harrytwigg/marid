import { useCallback, useState } from 'react'
import { clampSidebarWidth, collapsesSidebar } from './sidebar-width'
import { storeSidebarWidth, useSavedSidebarWidth } from './sidebar-width-store'

/**
 * The desktop chat list's width. `drag` previews the raw width the pointer produced; `commit`
 * saves an already-resolved open width. A drag that has run into the collapse zone is previewed
 * by `collapsed` and dropped on release (never saved), so the last open width is what reopens
 * the list. The stored width is clamped on the way out rather than rewritten, so a window
 * narrowed for a while does not forget the width chosen in a wide one.
 */
export function useSidebarWidth(viewportWidth: number) {
  const stored = useSavedSidebarWidth()
  const [live, setLive] = useState<number | null>(null)

  /** `width` must already be resolved open (resolveSidebarWidth), not raw: a collapse never
   * reaches storage. */
  const commit = useCallback((width: number) => {
    setLive(null)
    storeSidebarWidth(clampSidebarWidth(width, viewportWidth))
  }, [viewportWidth])
  const cancel = useCallback(() => setLive(null), [])
  const reset = useCallback(() => {
    setLive(null)
    storeSidebarWidth(null)
  }, [])
  const drag = useCallback((width: number) => setLive(Number.isFinite(width) ? width : null), [])

  return {
    width: clampSidebarWidth(live ?? stored, viewportWidth),
    /** While dragging, whether the raw width is in the collapse zone; the column renders shut
     * for it and only makes it permanent on commit. */
    collapsed: live !== null && collapsesSidebar(live),
    dragging: live !== null,
    drag,
    commit,
    cancel,
    reset,
  }
}
