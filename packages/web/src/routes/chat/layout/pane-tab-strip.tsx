import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type RefObject, type WheelEvent } from 'react'
import { X } from 'lucide-react'
import { splitTitleId } from '@/components/chat/chat-tabs'
import { StatusDot } from '@/components/chat/session-signals'
import { TERMINAL_AVATAR } from '@/components/ui/employee-avatar'
import { emojiForName } from '@/lib/emoji-pool'
import { activeChatSessionDrag, hasChatSessionDrag, readChatSessionDrop } from '../chat-session-dnd'
import { PaneFileTabLabel } from './pane-file-tab-label'
import {
  activePaneTabDrag,
  clearPaneTabDrag,
  hasPaneTabDrag,
  insertionIndexForPointer,
  paneTabDragProps,
  readPaneTabDrop,
  reorderTarget,
} from './pane-tab-dnd'

export interface PaneTabItem {
  id: string
  title: string
  employee?: string
  status?: 'running' | 'error'
  /** VS Code preview tab: italic, replaced by the next preview open until pinned. */
  preview?: boolean
  /** Set on a file preview tab: the path it shows, in full. */
  filePath?: string
}

export interface PaneTabStripProps {
  /** Identifies this strip as a drag source and drop target. */
  groupId: string
  tabs: readonly PaneTabItem[]
  activeId: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  /** A tab of this strip was dropped at `toIndex` in this same strip (already adjusted for its own removal). */
  onReorder: (tabId: string, toIndex: number) => void
  /** A tab of another strip was dropped here; `toIndex` is the insertion slot. */
  onMoveIn: (fromGroupId: string, tabId: string, toIndex: number) => void
  /** A chat dragged from the sidebar was dropped here; `toIndex` is the insertion slot. */
  onDropSession?: (sessionId: string, toIndex: number) => void
  /** Double-click promotes a preview tab to a pinned one. */
  onPin?: (tabId: string) => void
  /** Whether this strip's group is the focused one; only its shown tab carries the top marker. */
  focused?: boolean
}

const STATUS_DOT = {
  running: { color: 'var(--system-green)', label: 'running', pulse: true },
  error: { color: 'var(--system-red)', label: 'error', pulse: false },
} as const

type TabKeyAction = { kind: 'focus'; index: number } | { kind: 'reorder'; index: number } | { kind: 'close' }

function arrowAction(step: number, index: number, count: number, alt: boolean): TabKeyAction | null {
  if (!alt) return { kind: 'focus', index: (index + step + count) % count }
  const to = index + step
  return to < 0 || to >= count ? null : { kind: 'reorder', index: to }
}

/** Keyboard result for a key on the tab at `index`; null when the key is not ours. */
export function tabKeyAction(key: string, index: number, count: number, alt: boolean): TabKeyAction | null {
  if (count === 0) return null
  if (key === 'ArrowRight') return arrowAction(1, index, count, alt)
  if (key === 'ArrowLeft') return arrowAction(-1, index, count, alt)
  if (key === 'Home') return { kind: 'focus', index: 0 }
  if (key === 'End') return { kind: 'focus', index: count - 1 }
  return key === 'Delete' || key === 'Backspace' ? { kind: 'close' } : null
}

function tabNodes(list: HTMLElement | null): HTMLElement[] {
  return Array.from(list?.querySelectorAll<HTMLElement>('[data-pane-tab-id]') ?? [])
}

type DropHandlers = Pick<PaneTabStripProps, 'groupId' | 'tabs' | 'onReorder' | 'onMoveIn' | 'onDropSession'>

function acceptsDrag(event: DragEvent, onDropSession: DropHandlers['onDropSession']): boolean {
  return hasPaneTabDrag(event.dataTransfer) || (!!onDropSession && hasChatSessionDrag(event.dataTransfer))
}

/** Routes one drop to the callback that owns it: a tab of this strip, of another, or a sidebar chat. */
function routeDrop(event: DragEvent, slot: number, { groupId, tabs, onReorder, onMoveIn, onDropSession }: DropHandlers): void {
  if (hasPaneTabDrag(event.dataTransfer)) {
    const tab = readPaneTabDrop(event.dataTransfer) ?? activePaneTabDrag()
    clearPaneTabDrag()
    if (!tab) return
    if (tab.groupId !== groupId) return onMoveIn(tab.groupId, tab.tabId, slot)
    const from = tabs.findIndex((item) => item.id === tab.tabId)
    if (from >= 0 && reorderTarget(from, slot) !== from) onReorder(tab.tabId, reorderTarget(from, slot))
    return
  }
  const sessionId = readChatSessionDrop(event.dataTransfer) ?? activeChatSessionDrag()
  if (sessionId) onDropSession?.(sessionId, slot)
}

function useStripDrop(listRef: RefObject<HTMLElement | null>, handlers: DropHandlers) {
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const slotAt = (event: DragEvent) => insertionIndexForPointer(tabNodes(listRef.current).map((tab) => tab.getBoundingClientRect()), event.clientX)
  return {
    dropSlot,
    onDragOver: (event: DragEvent) => {
      if (!acceptsDrag(event, handlers.onDropSession)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = hasPaneTabDrag(event.dataTransfer) ? 'move' : 'copy'
      setDropSlot(slotAt(event))
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSlot(null)
    },
    onDrop: (event: DragEvent) => {
      if (!acceptsDrag(event, handlers.onDropSession)) return
      event.preventDefault()
      event.stopPropagation()
      setDropSlot(null)
      routeDrop(event, slotAt(event), handlers)
    },
  }
}

/** Keeps the active tab visible in an overflowing strip, and moves DOM focus after a keyboard reorder. */
function useTabVisibility(listRef: RefObject<HTMLElement | null>, activeId: string | null, tabs: readonly PaneTabItem[]) {
  const [focusId, setFocusId] = useState<string | null>(null)
  useEffect(() => {
    const node = tabNodes(listRef.current).find((tab) => tab.dataset.paneTabId === activeId)
    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [listRef, activeId, tabs.length])
  useEffect(() => {
    if (!focusId) return
    tabNodes(listRef.current).find((tab) => tab.dataset.paneTabId === focusId)?.focus()
    setFocusId(null)
  }, [listRef, focusId, tabs])
  return setFocusId
}

interface PaneTabProps {
  tab: PaneTabItem
  groupId: string
  active: boolean
  focused: boolean
  tabStop: boolean
  dropEdge: 'before' | 'after' | null
  onActivate: () => void
  onClose: () => void
  onPin?: () => void
  onKeyDown: (event: KeyboardEvent) => void
}

function PaneTabLabel({ tab, active }: { tab: PaneTabItem; active: boolean }) {
  const { id: numericId, rest } = splitTitleId(tab.title)
  const dot = tab.status ? STATUS_DOT[tab.status] : null
  return (
    <>
      <span aria-hidden className={`shrink-0 leading-none ${active ? 'opacity-100' : 'opacity-50'}`}>
        {tab.employee === TERMINAL_AVATAR ? '\u{1F5A5}\uFE0F' : emojiForName(tab.employee ?? 'chat')}
      </span>
      <span data-pane-tab-title className={`min-w-0 flex-1 truncate ${tab.preview ? 'italic' : ''}`}>
        {numericId ? <span data-pane-tab-number>{numericId} </span> : null}
        {rest || 'Chat'}
      </span>
      {dot ? <StatusDot color={dot.color} pulse={dot.pulse} title={dot.label} data-pane-tab-status={tab.status} className="size-1.5" /> : null}
    </>
  )
}

const TAB_CLASS = 'group/pane-tab relative flex h-full max-w-[200px] min-w-[96px] shrink-0 cursor-default select-none items-center gap-1.5 px-2.5 text-[length:var(--text-footnote)] transition-colors duration-[var(--duration-fast)] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--accent)] data-[drop-before]:shadow-[inset_2px_0_0_var(--accent)] data-[drop-after]:shadow-[inset_-2px_0_0_var(--accent)]'

/** The presence flags a tab carries for styling and tests: set to "true" or absent, never "false". */
function tabFlags(tab: PaneTabItem, active: boolean, dropEdge: PaneTabProps['dropEdge']) {
  return {
    'data-active': active ? 'true' : undefined,
    'data-preview': tab.preview ? 'true' : undefined,
    'data-drop-before': dropEdge === 'before' ? 'true' : undefined,
    'data-drop-after': dropEdge === 'after' ? 'true' : undefined,
  }
}

function TabCloseButton({ title, active, onClose }: { title: string; active: boolean; onClose: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-pane-focus-preserving
      aria-label={`Close tab ${title}`}
      onClick={(event) => { event.stopPropagation(); onClose() }}
      onMouseDown={(event) => event.stopPropagation()}
      className={`grid size-4 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] transition-opacity duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] ${active ? 'opacity-100' : 'opacity-0 group-hover/pane-tab:opacity-100'}`}
    >
      <X size={12} aria-hidden />
    </button>
  )
}

function PaneTab({ tab, groupId, active, focused, tabStop, dropEdge, onActivate, onClose, onPin, onKeyDown }: PaneTabProps) {
  // Middle-click closes; suppress the browser's autoscroll on mousedown.
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }
  return (
    <div
      role="tab"
      id={`pane-tab-${groupId}-${tab.id}`}
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      draggable
      data-pane-tab-id={tab.id}
      data-pane-tab-kind={tab.filePath !== undefined ? 'file' : undefined}
      {...tabFlags(tab, active, dropEdge)}
      title={tab.filePath ?? tab.title}
      {...paneTabDragProps({ groupId, tabId: tab.id })}
      onClick={onActivate}
      onDoubleClick={tab.preview ? onPin : undefined}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      className={`${TAB_CLASS} ${active ? 'bg-[var(--fill-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]'}`}
    >
      {active && focused ? <span aria-hidden data-pane-tab-marker className="absolute inset-x-0 top-0 h-[2px] bg-[var(--text-primary)]" /> : null}
      {tab.filePath !== undefined ? <PaneFileTabLabel title={tab.title} active={active} /> : <PaneTabLabel tab={tab} active={active} />}
      <TabCloseButton title={tab.title} active={active} onClose={onClose} />
    </div>
  )
}

function dropEdgeFor(slot: number | null, index: number, count: number): 'before' | 'after' | null {
  if (slot === index) return 'before'
  return slot === count && index === count - 1 ? 'after' : null
}

function handleTabKey(
  event: KeyboardEvent,
  index: number,
  { tabs, onActivate, onClose, onReorder }: PaneTabStripProps,
  setFocusId: (tabId: string) => void,
): void {
  const action = tabKeyAction(event.key, index, tabs.length, event.altKey)
  if (!action) return
  // Handled here and nowhere else: Delete and Backspace are also the app's delete-session keys, which
  // listen on window and would ask to delete the route's chat, not the tab being closed.
  event.preventDefault()
  event.stopPropagation()
  const tab = tabs[index]
  if (action.kind === 'close') return onClose(tab.id)
  if (action.kind === 'reorder') { onReorder(tab.id, action.index); return setFocusId(tab.id) }
  onActivate(tabs[action.index].id)
  setFocusId(tabs[action.index].id)
}

export function PaneTabStrip(props: PaneTabStripProps) {
  const { groupId, tabs, activeId, onActivate, onClose, onPin } = props
  const listRef = useRef<HTMLDivElement>(null)
  const drop = useStripDrop(listRef, props)
  const setFocusId = useTabVisibility(listRef, activeId, tabs)

  const onKeyDown = (event: KeyboardEvent, index: number) => handleTabKey(event, index, props, setFocusId)

  // Vertical wheel scrolls the strip sideways, as editor tab strips do.
  const onWheel = (event: WheelEvent) => {
    if (listRef.current && Math.abs(event.deltaX) < Math.abs(event.deltaY)) listRef.current.scrollLeft += event.deltaY
  }

  const tabStop = Math.max(0, tabs.findIndex((tab) => tab.id === activeId))
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="horizontal"
      data-testid="pane-tab-strip"
      data-pane-tab-group={groupId}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      onWheel={onWheel}
      className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab, index) => (
        <PaneTab
          key={tab.id}
          tab={tab}
          groupId={groupId}
          active={tab.id === activeId}
          focused={props.focused ?? false}
          tabStop={index === tabStop}
          dropEdge={dropEdgeFor(drop.dropSlot, index, tabs.length)}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
          onPin={onPin ? () => onPin(tab.id) : undefined}
          onKeyDown={(event) => onKeyDown(event, index)}
        />
      ))}
    </div>
  )
}
