import { useCallback, useState } from 'react'
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, loadSidebarWidth, saveSidebarWidth } from './sidebar-width'

/**
 * The desktop chat list's width. `drag` previews a width while the pointer moves; nothing is
 * saved until `commit`. The stored width is clamped on the way out rather than rewritten, so a
 * window narrowed for a while does not forget the width chosen in a wide one.
 */
export function useSidebarWidth(viewportWidth: number) {
  const [stored, setStored] = useState<number>(() => loadSidebarWidth() ?? DEFAULT_SIDEBAR_WIDTH)
  const [live, setLive] = useState<number | null>(null)

  const commit = useCallback((width: number) => {
    const next = clampSidebarWidth(width, viewportWidth)
    setLive(null)
    setStored(next)
    saveSidebarWidth(next)
  }, [viewportWidth])
  const cancel = useCallback(() => setLive(null), [])
  const reset = useCallback(() => {
    setLive(null)
    setStored(DEFAULT_SIDEBAR_WIDTH)
    saveSidebarWidth(null)
  }, [])
  const drag = useCallback((width: number) => setLive(clampSidebarWidth(width, viewportWidth)), [viewportWidth])

  return {
    width: clampSidebarWidth(live ?? stored, viewportWidth),
    dragging: live !== null,
    drag,
    commit,
    cancel,
    reset,
  }
}
