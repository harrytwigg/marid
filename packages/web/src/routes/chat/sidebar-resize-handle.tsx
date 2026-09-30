import { SplitHandleBar } from './layout/split-handle'
import { sidebarHandle, widthFromSizes } from './sidebar-width'

interface SidebarResizeHandleProps {
  width: number
  viewport: { width: number; height: number }
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onCancel: () => void
  onReset: () => void
}

/**
 * The drag handle on the chat list's right edge. It sits in a zero-width strip at that edge:
 * the strip clips vertically only, so the handle's hit area can reach past the edge into the
 * thread as the split panes' handles do.
 */
export function SidebarResizeHandle({ width, viewport, onDrag, onCommit, onCancel, onReset }: SidebarResizeHandleProps) {
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 w-0 overflow-y-clip [&>*]:pointer-events-auto">
      <SplitHandleBar
        handle={sidebarHandle(width, viewport.width, viewport.height)}
        label="Resize chat list"
        onDrag={(sizes) => onDrag(widthFromSizes(sizes, viewport.width))}
        onCommit={(sizes) => onCommit(widthFromSizes(sizes, viewport.width))}
        onCancel={onCancel}
        onReset={onReset}
      />
    </div>
  )
}
