import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'
import {
  activeChatSessionDrag,
  clearChatSessionDrag,
  hasChatSessionDrag,
  isComposerDropTarget,
  readChatSessionDrop,
} from '../chat-session-dnd'
import { capForViewport, layoutFor } from '../grid-layout'
import { findGroup, focusedGroup, groupIdsByPaneKey, paneKeyOf, paneKeysFromLayout, paneSessionOf, type SplitLayout } from './split-layout'
import { splitDropForPointer, type Rect, type SplitDropHit, type SplitDropRegion } from './split-geometry'
import { applySplitDrop, previewSplitDrop, type SplitDropContext } from './split-drop'
import { clearPaneTabDrag, fileTabDragId, isTabStripDropTarget, readPaneTabDrop } from './pane-tab-dnd'
import { isFileTabId } from './file-tab'

type DropHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>
type SelectSession = (id: string, options?: { navigateMobile?: boolean; replace?: boolean }) => void

export interface SplitDropPlacement {
  region: SplitDropRegion
  /** Where the session enters the working set, in the flat grid's terms (data-drop-index). */
  targetIndex: number
  previewRect: Rect
  hit: SplitDropHit
}

export interface SplitGridAddContext {
  primaryPaneKey: string
  committedSessionId: string | null
  pickerPaneKey: string | null
  viewport: { width: number; height: number }
}

interface SplitWorkingSet {
  add: (sessionId: string) => void
  drop: (sessionId: string, hit: SplitDropHit, context: SplitDropContext) => void
  split: { layout: SplitLayout }
}

/** A drag the pane surface takes: a chat (from the sidebar or a chat tab) or a file tab. */
function hasSplitDrag(dataTransfer: DataTransfer): boolean {
  return hasChatSessionDrag(dataTransfer) || fileTabDragId(dataTransfer) !== null
}

/** The tab or chat being dragged, during a drag (the payload is unreadable until the drop). */
function draggedId(dataTransfer: DataTransfer): string | null {
  return readChatSessionDrop(dataTransfer) ?? activeChatSessionDrag() ?? fileTabDragId(dataTransfer)
}

function eligibleDrop(event: DragEvent): boolean {
  return hasSplitDrag(event.dataTransfer) && !isComposerDropTarget(event.target) && !isTabStripDropTarget(event.target)
}

function pointerInside(node: HTMLElement, x: number, y: number): boolean {
  const rect = node.getBoundingClientRect()
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

function flatIndex(layout: SplitLayout, hit: SplitDropHit): number {
  const members = paneKeysFromLayout(layout)
  const target = hit.groupId ? findGroup(layout, hit.groupId) : null
  const index = target ? members.indexOf(paneKeyOf(target, layout.focusHistory)) : -1
  if (index < 0 || hit.region === 'end') return members.length
  return hit.region === 'right' || hit.region === 'bottom' ? index + 1 : index
}

interface MeasureInput {
  layout: SplitLayout
  sessionId: string
  context: SplitGridAddContext
  sessionForKey: (key: string) => string | null
}

function measure(event: DragEvent, { layout, sessionId, context, sessionForKey }: MeasureInput): SplitDropPlacement | null {
  const grid = event.currentTarget.querySelector<HTMLElement>('[data-testid="chat-grid"]')
  if (!grid) return null
  const groupByPaneKey = groupIdsByPaneKey(layout)
  const panes = Array.from(grid.querySelectorAll<HTMLElement>('[data-chat-grid-pane]')).map((pane) => {
    const key = pane.dataset.chatGridPane ?? ''
    const paneKey = isFileTabId(key) ? key : sessionForKey(key)
    const rect = pane.getBoundingClientRect()
    return { key, groupId: paneKey ? groupByPaneKey.get(paneKey) ?? null : null, rect, hitRect: aboveComposer(pane, rect) }
  })
  const gridBox = grid.getBoundingClientRect()
  const gridRect = { left: gridBox.left, top: gridBox.top, width: gridBox.width, height: gridBox.height }
  const hit = splitDropForPointer({ x: event.clientX, y: event.clientY }, panes, gridRect)
  if (!hit) return null
  const spacing = Number.parseFloat(getComputedStyle(grid).getPropertyValue('--space-2')) || 0
  const preview = previewSplitDrop({
    layout,
    sessionId,
    hit,
    context: dropContext(panes.length, context),
    gridRect,
    viewport: context.viewport,
    metrics: { padding: spacing, gap: spacing },
    pickerPaneKey: context.pickerPaneKey,
  })
  if (!preview) return null
  return { region: hit.region, targetIndex: flatIndex(layout, hit), previewRect: preview.rect, hit }
}

/** The pane above its composer, where drop regions are measured (split-geometry.ts DropPane). */
function aboveComposer(pane: HTMLElement, rect: DOMRect): Rect | undefined {
  const composer = pane.querySelector('[data-chat-composer]')?.getBoundingClientRect()
  if (!composer || composer.top <= rect.top || composer.top >= rect.bottom) return undefined
  return { left: rect.left, top: rect.top, width: rect.width, height: composer.top - rect.top }
}

function dropContext(mountedPanes: number, context: SplitGridAddContext): SplitDropContext {
  const { width, height } = context.viewport
  return { columns: layoutFor(mountedPanes, width, height).columns, cap: capForViewport(width, height) }
}

function useDragEndClear(active: boolean, clear: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') clear() }
    window.addEventListener('dragend', clear)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [active, clear])
}

function useDropOverlay() {
  const [active, setActive] = useState(false)
  const [placement, setPlacement] = useState<SplitDropPlacement | null>(null)
  const placementRef = useRef<SplitDropPlacement | null>(null)
  const depthRef = useRef(0)
  const clearOverlay = useCallback(() => {
    depthRef.current = 0
    placementRef.current = null
    setPlacement(null)
    setActive(false)
  }, [])
  const finishDrag = useCallback(() => {
    clearOverlay()
    clearChatSessionDrag()
    clearPaneTabDrag()
  }, [clearOverlay])
  useDragEndClear(active, finishDrag)
  return { active, setActive, placement, setPlacement, placementRef, depthRef, clearOverlay, finishDrag }
}

interface DropHandlerDeps {
  overlay: ReturnType<typeof useDropOverlay>
  measureAt: (event: DragEvent, sessionId: string) => SplitDropPlacement | null
  onDrop: (sessionId: string, hit: SplitDropHit, mountedPanes: number) => void
}

function droppedFileTab(dataTransfer: DataTransfer): string | null {
  const tabId = readPaneTabDrop(dataTransfer)?.tabId ?? fileTabDragId(dataTransfer)
  return tabId !== undefined && tabId !== null && isFileTabId(tabId) ? tabId : null
}

/** chat-grid-drop.tsx createDropHandlers, releasing into the split layout. */
function createSplitDropHandlers({ overlay, measureAt, onDrop }: DropHandlerDeps): DropHandlers {
  const update = (event: DragEvent): SplitDropPlacement | null => {
    const sessionId = draggedId(event.dataTransfer)
    const next = sessionId ? measureAt(event, sessionId) : null
    overlay.placementRef.current = next
    overlay.setPlacement(next)
    return next
  }
  return {
    onDragEnter: (event) => {
      if (hasSplitDrag(event.dataTransfer) && (isComposerDropTarget(event.target) || isTabStripDropTarget(event.target))) {
        overlay.clearOverlay()
        return
      }
      if (!eligibleDrop(event)) return
      event.preventDefault()
      overlay.depthRef.current += 1
      overlay.setActive(true)
      update(event)
    },
    onDragLeave: (event) => {
      if (!hasSplitDrag(event.dataTransfer)) return
      overlay.depthRef.current = Math.max(0, overlay.depthRef.current - 1)
      if (overlay.depthRef.current === 0 && !pointerInside(event.currentTarget, event.clientX, event.clientY)) overlay.clearOverlay()
    },
    onDragOver: (event) => {
      if (!eligibleDrop(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      overlay.setActive(Boolean(update(event)))
    },
    onDrop: (event) => {
      if (!eligibleDrop(event)) return
      const sessionId = readChatSessionDrop(event.dataTransfer) ?? droppedFileTab(event.dataTransfer)
      const hit = overlay.placementRef.current?.hit ?? { region: 'end' as const, key: null, groupId: null }
      const mounted = event.currentTarget.querySelectorAll('[data-chat-grid-pane]').length
      overlay.finishDrag()
      if (!sessionId) return
      event.preventDefault()
      event.stopPropagation()
      onDrop(sessionId, hit, mounted)
    },
  }
}

/** The chat the focused pane belongs to once a file tab is dropped, or null (a file-only pane is focused). */
function chatAfterFileDrop(layout: SplitLayout, fileTabId: string, hit: SplitDropHit, context: SplitDropContext): string | null {
  const after = applySplitDrop(layout, fileTabId, hit, context)
  const focused = focusedGroup(after)
  return (focused ? paneSessionOf(focused, after.focusHistory) : '') || null
}

/**
 * use-chat-grid-add.ts for the split layout: the same sidebar drag (chat-session-dnd.ts) and the
 * same drop-surface contract as chat-grid-drop.tsx useChatSessionDrop, but a release resolves to
 * a split, a tab or an append (split-drop.ts) instead of a flat-list index.
 */
export function useSplitGridAdd(
  workingSet: SplitWorkingSet,
  selectedId: string | null,
  selectSession: SelectSession,
  context: SplitGridAddContext,
) {
  const { add, drop: dropInto, split } = workingSet
  const { primaryPaneKey, committedSessionId, pickerPaneKey } = context
  const sessionForKey = useCallback((key: string): string | null => {
    if (key === pickerPaneKey || isFileTabId(key)) return null
    return key === primaryPaneKey ? committedSessionId : key
  }, [committedSessionId, pickerPaneKey, primaryPaneKey])

  const addPane = useCallback((sessionId: string) => {
    add(sessionId)
    if (sessionId !== selectedId) selectSession(sessionId, { navigateMobile: false })
  }, [add, selectSession, selectedId])

  const overlay = useDropOverlay()
  const handlers = useMemo(() => createSplitDropHandlers({
    overlay,
    measureAt: (event, sessionId) => measure(event, { layout: split.layout, sessionId, context, sessionForKey }),
    onDrop: (sessionId, hit, mountedPanes) => {
      const dropContextNow = dropContext(mountedPanes, context)
      dropInto(sessionId, hit, dropContextNow)
      // A chat is the route. A file tab is not: the route follows the chat of the pane that ends up
      // focused, and stays put when that is a file-only pane (it has none).
      const routed = isFileTabId(sessionId) ? chatAfterFileDrop(split.layout, sessionId, hit, dropContextNow) : sessionId
      if (routed && routed !== selectedId) selectSession(routed, { navigateMobile: false })
    },
  }), [context, dropInto, overlay, selectSession, selectedId, sessionForKey, split.layout])

  return { addPane, drop: { active: overlay.active, placement: overlay.placement, handlers }, sessionForKey }
}
