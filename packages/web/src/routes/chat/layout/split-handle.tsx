import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { moveHandle } from './split-layout'
import type { SplitHandle } from './split-geometry'

/** One arrow press, in pixels; Shift moves four times as far. */
export const KEYBOARD_STEP = 16

interface SplitHandleBarProps {
  handle: SplitHandle
  /** Live sizes while the pointer moves; nothing is persisted until onCommit. */
  onDrag: (sizes: number[]) => void
  onCommit: (sizes: number[]) => void
  onCancel: () => void
  /** Double-click: every child of this split back to an equal share. */
  onReset: () => void
}

interface DragStart {
  pointerId: number
  origin: number
  sizes: number[]
  latest: number[]
}

function sizesAfter(handle: SplitHandle, start: readonly number[], pixels: number): number[] {
  return moveHandle(start, handle.index, handle.extent > 0 ? pixels / handle.extent : 0, handle.minimums)
}

function keyboardDelta(handle: SplitHandle, event: KeyboardEvent): number | null {
  const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP
  const [decrease, increase] = handle.direction === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  if (event.key === decrease) return -step
  if (event.key === increase) return step
  // Home/End run the handle to either stop; moveHandle clamps at the neighbours' minimums.
  if (event.key === 'Home') return -handle.extent
  if (event.key === 'End') return handle.extent
  return null
}

function useHandleDrag(handle: SplitHandle, { onDrag, onCommit, onCancel }: Pick<SplitHandleBarProps, 'onDrag' | 'onCommit' | 'onCancel'>) {
  const dragRef = useRef<DragStart | null>(null)
  const row = handle.direction === 'row'
  const end = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const moved = drag.latest.some((size, index) => size !== drag.sizes[index])
    if (commit && moved) onCommit(drag.latest)
    else onCancel()
  }
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const sizes = [...handle.sizes]
      dragRef.current = { pointerId: event.pointerId, origin: row ? event.clientX : event.clientY, sizes, latest: sizes }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      drag.latest = sizesAfter(handle, drag.sizes, (row ? event.clientX : event.clientY) - drag.origin)
      onDrag(drag.latest)
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => end(event, true),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => end(event, true),
  }
}

/** The hit area reaches past the gutter into both panes, like an editor sash, so the 8px
 * gutter is not the whole target. */
const REACH = 4

function handleStyle(handle: SplitHandle) {
  const { rect } = handle
  return handle.direction === 'row'
    ? { left: rect.left - REACH, top: rect.top, width: rect.width + REACH * 2, height: rect.height }
    : { left: rect.left, top: rect.top - REACH, width: rect.width, height: rect.height + REACH * 2 }
}

/**
 * A splitter in the gutter between two panes, following the WAI-ARIA window-splitter pattern: a
 * focusable separator whose value is the share of the pair held by the pane before it.
 */
export function SplitHandleBar({ handle, onDrag, onCommit, onCancel, onReset }: SplitHandleBarProps) {
  const pointer = useHandleDrag(handle, { onDrag, onCommit, onCancel })
  const row = handle.direction === 'row'
  const pair = handle.sizes[handle.index] + handle.sizes[handle.index + 1]
  const value = pair > 0 ? Math.round((handle.sizes[handle.index] / pair) * 100) : 50
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = keyboardDelta(handle, event)
    if (delta === null) return
    event.preventDefault()
    onCommit(sizesAfter(handle, handle.sizes, delta))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={row ? 'Resize panes left and right' : 'Resize panes up and down'}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      data-split-handle={`${handle.splitId}:${handle.index}`}
      {...pointer}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={`group/split-handle absolute z-10 flex touch-none items-center justify-center outline-none ${row ? 'cursor-col-resize' : 'cursor-row-resize'}`}
      style={handleStyle(handle)}
    >
      <span
        aria-hidden
        className={`rounded-full bg-[var(--accent)] opacity-0 transition-opacity duration-150 group-hover/split-handle:opacity-60 group-focus-visible/split-handle:opacity-100 group-active/split-handle:opacity-100 ${row ? 'h-full w-0.5' : 'h-0.5 w-full'}`}
      />
    </div>
  )
}
