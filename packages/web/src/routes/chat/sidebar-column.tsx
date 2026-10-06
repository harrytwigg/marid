import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarResizeHandle } from './sidebar-resize-handle'
import { clampSidebarWidth, collapsesSidebar, resolveSidebarWidth } from './sidebar-width'
import { useSidebarWidth } from './use-sidebar-width'

/** What a release means for the list. A keyboard step (`dragging` false) never folds it: it
 * stops an open list at the open minimum, and reopens a folded one at its last open width (a
 * null width). A drag that reaches the zone folds it. Pure, so the column body stays in budget. */
type CommitAction = { fold: true } | { fold: false; width: number | null }
function commitAction(width: number, dragging: boolean, collapsed: boolean, viewportWidth: number): CommitAction {
  if (!dragging && collapsesSidebar(width)) {
    return { fold: false, width: collapsed ? null : clampSidebarWidth(width, viewportWidth) }
  }
  const resolved = resolveSidebarWidth(width, viewportWidth)
  return resolved.collapsed ? { fold: true } : { fold: false, width: resolved.width }
}

/**
 * The desktop chat list's column: it folds by animating its width, and its right edge drags to
 * resize or, pulled down into the collapse zone (sidebar-width.ts), to shut the list. The list
 * inside keeps its dragged width, so its contents don't reflow mid-fold. The width follows the
 * pointer while the handle drags, so it must not ease behind it. The handle stays mounted while
 * the list is folded, at the ribbon's edge, so dragging back out reopens it.
 */
export function SidebarColumn({ open, viewport, onOpenChange, children }: {
  open: boolean
  viewport: { width: number; height: number }
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const sidebar = useSidebarWidth(viewport.width)
  // While dragging the pointer decides; otherwise the persisted state does. A previewed collapse
  // is not made permanent until release.
  const collapsed = sidebar.dragging ? sidebar.collapsed : !open
  const commit = (width: number) => {
    const action = commitAction(width, sidebar.dragging, collapsed, viewport.width)
    if (action.fold) {
      sidebar.cancel()
      onOpenChange(false)
      return
    }
    // A null width reopens at the stored value (cancel drops the live preview).
    if (action.width === null) sidebar.cancel()
    else sidebar.commit(action.width)
    onOpenChange(true)
  }
  return (
    <div
      className={cn(
        'relative h-full shrink-0',
        !sidebar.dragging && 'transition-[width] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none',
      )}
      style={{ width: collapsed ? 0 : sidebar.width }}
    >
      <div className="h-full overflow-hidden" aria-hidden={collapsed}>
        <div className="h-full" style={{ width: sidebar.width }}>{children}</div>
      </div>
      <SidebarResizeHandle
        width={collapsed ? 0 : sidebar.width}
        viewport={viewport}
        onDrag={sidebar.drag}
        onCommit={commit}
        onCancel={sidebar.cancel}
        onReset={() => { sidebar.reset(); onOpenChange(true) }}
      />
    </div>
  )
}
