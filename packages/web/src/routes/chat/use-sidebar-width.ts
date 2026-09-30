import { useCallback, useState } from 'react'
import { clampSidebarWidth } from './sidebar-width'
import { storeSidebarWidth, useSavedSidebarWidth } from './sidebar-width-store'

/**
 * The desktop chat list's width. `drag` previews a width while the pointer moves; nothing is
 * saved until `commit`. The stored width is clamped on the way out rather than rewritten, so a
 * window narrowed for a while does not forget the width chosen in a wide one.
 */
export function useSidebarWidth(viewportWidth: number) {
  const stored = useSavedSidebarWidth()
  const [live, setLive] = useState<number | null>(null)

  const commit = useCallback((width: number) => {
    const next = clampSidebarWidth(width, viewportWidth)
    setLive(null)
    storeSidebarWidth(next)
  }, [viewportWidth])
  const cancel = useCallback(() => setLive(null), [])
  const reset = useCallback(() => {
    setLive(null)
    storeSidebarWidth(null)
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
