import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarResizeHandle } from './sidebar-resize-handle'
import { useSidebarWidth } from './use-sidebar-width'

/**
 * The desktop chat list's column: it folds by animating its width, and its right edge drags to
 * resize. The list inside keeps its dragged width, so its contents don't reflow mid-fold. The
 * width follows the pointer while the handle drags, so it must not ease behind it.
 */
export function SidebarColumn({ open, viewport, children }: {
  open: boolean
  viewport: { width: number; height: number }
  children: ReactNode
}) {
  const sidebar = useSidebarWidth(viewport.width)
  return (
    <div
      className={cn(
        'relative h-full shrink-0',
        !sidebar.dragging && 'transition-[width] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none',
      )}
      style={{ width: open ? sidebar.width : 0 }}
    >
      <div className="h-full overflow-hidden" aria-hidden={!open}>
        <div className="h-full" style={{ width: sidebar.width }}>{children}</div>
      </div>
      {open && (
        <SidebarResizeHandle
          width={sidebar.width}
          viewport={viewport}
          onDrag={sidebar.drag}
          onCommit={sidebar.commit}
          onCancel={sidebar.cancel}
          onReset={sidebar.reset}
        />
      )}
    </div>
  )
}
