import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefCallback } from 'react'
import type { ChatGrid } from '../chat-grid'
import { useChatGridMotion } from '../use-chat-grid-motion'
import { focusedGroup, paneKeyOf, setVisibleSplitSizes } from './split-layout'
import { isFileTabId } from './file-tab'
import { usePaneTabsFilePane } from '@/components/chat/pane-tabs-context'
import { splitGeometry, type Rect, type SplitHandle } from './split-geometry'
import { PaneTabsProvider } from './pane-tabs-provider'
import { useTabSwitchedIn } from './pane-tab-switch'
import './pane-tab-switch.css'
import { SplitHandleBar } from './split-handle'
import type { SplitLayoutControls } from './use-split-working-set'

type ChatGridProps = ComponentProps<typeof ChatGrid>

export interface SplitGridBinding {
  split: SplitLayoutControls
  sessionForKey: (key: string) => string | null
}

/** How the page hands the layout to the grid MultiChatGrid mounts, which only passes
 * ChatGrid's own props through. */
export const SplitGridContext = createContext<SplitGridBinding | null>(null)

interface PaneFrameProps {
  paneKey: string
  active: boolean
  singlePane: boolean
  rect: Rect
  folded: boolean
  /** The pane mounts because its group switched to a tab it already held. */
  byTabSwitch: boolean
  onFocus: (paneKey: string) => void
  paneRef: RefCallback<HTMLElement>
  children: ReactNode
}

/** chat-grid.tsx's PaneFrame, placed by geometry instead of by CSS grid flow. */
function PaneFrame({ paneKey, active, singlePane, rect, folded, byTabSwitch, onFocus, paneRef, children }: PaneFrameProps) {
  // Latched at mount: how the pane arrived does not change while it is showing.
  const [arrival] = useState(byTabSwitch ? 'tab-switch' : undefined)
  return (
    <section
      ref={paneRef}
      data-pane-arrival={arrival}
      data-testid={`pane-${paneKey}`}
      data-chat-grid-pane={paneKey}
      data-grid-active={String(active)}
      data-grid-motion="idle"
      data-chat-grid-folded={folded ? '' : undefined}
      hidden={folded}
      aria-current={!singlePane && active ? 'true' : undefined}
      onClick={() => onFocus(paneKey)}
      className={`absolute ${folded ? 'hidden' : 'flex'} min-h-0 min-w-0 origin-top-left overflow-hidden ${singlePane ? '' : `rounded-[var(--radius-lg)] ${active ? 'shadow-[var(--shadow-card)]' : 'shadow-none'}`}`}
      style={singlePane ? { inset: 0 } : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {children}
    </section>
  )
}

function useBox(node: HTMLDivElement | null): { box: Rect; spacing: number; measured: boolean } {
  const [measured, setMeasured] = useState<{ width: number; height: number; spacing: number } | null>(null)
  useLayoutEffect(() => {
    if (!node) return
    const read = () => {
      const spacing = Number.parseFloat(getComputedStyle(node).getPropertyValue('--space-2')) || 0
      const { width, height } = node.getBoundingClientRect()
      setMeasured((current) => (
        current && current.width === width && current.height === height && current.spacing === spacing ? current : { width, height, spacing }
      ))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  const width = measured?.width ?? 0
  const height = measured?.height ?? 0
  const box = useMemo(() => ({ left: 0, top: 0, width, height }), [height, width])
  // Any measurement counts, 0x0 included: jsdom measures everything at 0x0, and on desktop the
  // grid is never display:none (page.tsx keeps the thread column lg:flex).
  return { box, spacing: measured?.spacing ?? 0, measured: measured !== null }
}

interface DragOverride {
  splitId: string
  childIds: string[]
  sizes: number[]
}

/**
 * The split-layout counterpart of chat-grid.tsx ChatGrid, with the same props and the same pane
 * DOM contract (data-chat-grid-pane, data-grid-motion, the grid's test id), so MultiChatGrid,
 * the drop surface and the e2e suite drive it unchanged. Panes are siblings positioned from
 * split-geometry.ts: moving one through the tree changes its style, never its parent, so a
 * split or a resize never remounts a live chat.
 */
export function SplitChatGrid(props: ChatGridProps) {
  const binding = useContext(SplitGridContext)
  if (!binding) throw new Error('SplitChatGrid needs a SplitGridContext provider (routes/chat/page.tsx)')
  return (
    <PaneTabsProvider split={binding.split} onSelect={props.onFocus}>
      <SplitLayoutGrid {...props} {...binding} />
    </PaneTabsProvider>
  )
}

/**
 * The grid's props with the file-only panes handled here: a file pane's key is a file tab id, no
 * session, so the page's chat renderer and focus handler never see one. Focusing it shows its tab
 * and focuses its group (the route stays on the last chat), and while it holds focus it is the
 * active pane, which the page's focused chat is not.
 */
function useFilePaneProps(props: ChatGridProps, split: SplitLayoutControls): Pick<ChatGridProps, 'focusedId' | 'onFocus' | 'renderPane'> {
  const renderFilePane = usePaneTabsFilePane()
  const focused = focusedGroup(split.layout)
  const focusedPaneKey = focused ? paneKeyOf(focused, split.layout.focusHistory) : null
  const { onFocus, renderPane } = props
  return {
    focusedId: focusedPaneKey && isFileTabId(focusedPaneKey) ? focusedPaneKey : props.focusedId,
    onFocus: (key) => (isFileTabId(key) ? split.show(key) : onFocus(key)),
    renderPane: (key, active) => (isFileTabId(key) ? renderFilePane(key) : renderPane(key, active)),
  }
}

/** The grid element, measured, and the motion hook's ref on it. */
function useGridNode(gridRef: { current: HTMLDivElement | null }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const refCallback = useRef<RefCallback<HTMLDivElement> | null>(null)
  refCallback.current ??= (element) => {
    gridRef.current = element
    setNode(element)
  }
  return { ref: refCallback.current, ...useBox(node) }
}

/** Geometry for the committed layout, and for the live sizes while a splitter is dragged. */
function useSplitGridGeometry(props: ChatGridProps & SplitGridBinding, box: Rect, spacing: number, drag: DragOverride | null) {
  const { sessionIds, sessionForKey, width, height, split } = props
  const input = useMemo(() => ({
    keys: sessionIds,
    sessionForKey,
    box,
    viewport: { width, height },
    metrics: { padding: spacing, gap: spacing },
  }), [box, height, sessionForKey, sessionIds, spacing, width])
  const base = useMemo(() => splitGeometry({ ...input, layout: split.layout }), [input, split.layout])
  // A drag whose handle went away mid-gesture (a pane landed, folded, or the picker opened)
  // must not keep steering the grid: its handle can no longer end it.
  const live = drag && base.handles.some((handle) => handle.splitId === drag.splitId) ? drag : null
  const geometry = useMemo(() => (
    live ? splitGeometry({ ...input, layout: setVisibleSplitSizes(base.handleLayout, live.splitId, live.childIds, live.sizes) }) : base
  ), [base, input, live])
  return { base, geometry }
}

function SplitHandles({ handles, columns, split, setDrag }: {
  handles: SplitHandle[]
  columns: number
  split: SplitLayoutControls
  setDrag: (drag: DragOverride | null) => void
}) {
  return handles.map((handle) => (
    <SplitHandleBar
      key={`${handle.splitId}:${handle.index}`}
      handle={handle}
      onDrag={(sizes) => setDrag({ splitId: handle.splitId, childIds: handle.childIds, sizes })}
      onCommit={(sizes) => {
        setDrag(null)
        split.resize(columns, handle.splitId, handle.childIds, sizes)
      }}
      onCancel={() => setDrag(null)}
      onReset={() => {
        setDrag(null)
        split.equalize(columns, handle.splitId)
      }}
    />
  ))
}

function SplitLayoutGrid(binding: ChatGridProps & SplitGridBinding) {
  const props = { ...binding, ...useFilePaneProps(binding, binding.split) }
  const { sessionIds, focusedId, onFocus, renderPane, split } = props
  const motion = useChatGridMotion(sessionIds)
  const grid = useGridNode(motion.gridRef)
  const [drag, setDrag] = useState<DragOverride | null>(null)
  const { base, geometry } = useSplitGridGeometry(props, grid.box, grid.spacing, drag)
  const dragAlive = !drag || base.handles.some((handle) => handle.splitId === drag.splitId)
  useEffect(() => { if (!dragAlive) setDrag(null) }, [dragAlive])
  const singlePane = sessionIds.length <= 1
  const switchedIn = useTabSwitchedIn(split.layout)
  const paneFor = new Map(geometry.panes.map((pane) => [pane.key, pane]))

  return (
    <div
      ref={grid.ref}
      data-testid="chat-grid"
      data-split-layout={split.layout.auto ? 'auto' : 'arranged'}
      data-columns={geometry.columns || undefined}
      data-rows={geometry.rows || undefined}
      data-single-pane={String(singlePane)}
      className={`relative min-h-0 flex-1 overflow-hidden ${singlePane ? '' : 'bg-[var(--fill-quaternary)]'}`}
    >
      {/* Split panes wait for the first measurement (a layout effect, so still before paint):
          mounted into a 0x0 box, a composer sizes its textarea to a zero-width wrap and keeps
          it. A lone pane fills the grid by CSS and mounts at once — the phone remounts the grid
          on every switch (MultiChatGrid's crossfade), and must never commit a frame without it. */}
      {(grid.measured || singlePane) && sessionIds.map((paneKey) => (
        <PaneFrame
          key={paneKey}
          paneKey={paneKey}
          active={paneKey === focusedId}
          singlePane={singlePane}
          rect={paneFor.get(paneKey)?.rect ?? grid.box}
          folded={paneFor.get(paneKey)?.folded ?? false}
          byTabSwitch={switchedIn.has(paneKey)}
          onFocus={onFocus}
          paneRef={motion.paneRef(paneKey)}
        >
          {renderPane(paneKey, paneKey === focusedId)}
        </PaneFrame>
      ))}
      <SplitHandles handles={geometry.handles} columns={base.columns} split={split} setDrag={setDrag} />
    </div>
  )
}
