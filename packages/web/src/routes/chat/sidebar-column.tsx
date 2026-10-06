import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarResizeHandle } from './sidebar-resize-handle'
import { resolveSidebarWidth } from './sidebar-width'
import { useSidebarWidth } from './use-sidebar-width'

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
    const resolved = resolveSidebarWidth(width, viewport.width)
    if (!resolved.collapsed) {
      sidebar.commit(resolved.width)
      onOpenChange(true)
      return
    }
    sidebar.cancel()
    // Already shut, and this was a keyboard step rather than a drag (a drag that reached the
    // zone leaves it shut): the edge has nowhere further to go, so a step must mean "reopen".
    onOpenChange(collapsed && !sidebar.dragging)
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
