import type { DragEvent } from 'react'
import { clearChatSessionDrag, writeChatSessionDrag } from '../chat-session-dnd'

/** Carries a tab being dragged between (or within) pane tab strips. */
export const PANE_TAB_DND_MIME = 'application/x-jinn-pane-tab'

export interface PaneTabDragPayload {
  groupId: string
  tabId: string
}

// dataTransfer.getData is unreadable during dragover, so the in-flight payload also lives here.
let activeDrag: PaneTabDragPayload | null = null

export function hasPaneTabDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(PANE_TAB_DND_MIME)
}

/**
 * A tab drag is also a chat-session drag (the tab's id is its session id), so the split layout's pane drop
 * surface takes it with no knowledge of tabs: the middle of a pane adds the tab there, an edge
 * splits the pane. The tab MIME rides along for the strips, which need to know where it came from.
 */
export function writePaneTabDrag(dataTransfer: DataTransfer, payload: PaneTabDragPayload): void {
  writeChatSessionDrag(dataTransfer, payload.tabId)
  activeDrag = payload
  dataTransfer.setData(PANE_TAB_DND_MIME, JSON.stringify(payload))
  dataTransfer.effectAllowed = 'copyMove'
}

export function activePaneTabDrag(): PaneTabDragPayload | null {
  return activeDrag
}

export function clearPaneTabDrag(): void {
  activeDrag = null
  clearChatSessionDrag()
}

export function readPaneTabDrop(dataTransfer: DataTransfer): PaneTabDragPayload | null {
  if (!hasPaneTabDrag(dataTransfer)) return null
  try {
    const parsed = JSON.parse(dataTransfer.getData(PANE_TAB_DND_MIME)) as Partial<PaneTabDragPayload>
    return typeof parsed.groupId === 'string' && typeof parsed.tabId === 'string'
      ? { groupId: parsed.groupId, tabId: parsed.tabId }
      : null
  } catch {
    return null
  }
}

/** The drag half of a tab: start writes the payload, end clears it (mirrors chatSessionDragProps). */
export function paneTabDragProps(payload: PaneTabDragPayload) {
  return {
    onDragStart: (event: DragEvent) => writePaneTabDrag(event.dataTransfer, payload),
    onDragEnd: clearPaneTabDrag,
  }
}

/** True for a drag event that is over a tab strip, which handles its own drops. */
export function isTabStripDropTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-pane-tab-group]') !== null
}

/** Slot (0..rects.length) a pointer at `x` would insert into: before the first tab whose midpoint is right of it. */
export function insertionIndexForPointer(rects: readonly { left: number; width: number }[], x: number): number {
  const index = rects.findIndex((rect) => x < rect.left + rect.width / 2)
  return index < 0 ? rects.length : index
}

/** Final index of a tab moved within its own strip when dropped on insertion slot `insertion`. */
export function reorderTarget(from: number, insertion: number): number {
  return insertion > from ? insertion - 1 : insertion
}
