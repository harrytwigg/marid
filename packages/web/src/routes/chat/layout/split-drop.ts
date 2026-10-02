import { overflowForViewport } from '../grid-layout'
import {
  appendFileTab,
  appendSession,
  keepingFiles,
  closeSession,
  evictToCap,
  findGroup,
  groupOfSession,
  materializeLayout,
  paneSessionOf,
  paneSetFromLayout,
  placeTab,
  focusSession,
  splitGroup,
  type LayoutGroup,
  type SplitLayout,
  type SplitSide,
} from './split-layout'
import { splitGeometry, type Rect, type SplitDropHit, type SplitMetrics } from './split-geometry'
import { isFileTabId } from './file-tab'

export interface SplitDropContext {
  /** Columns the auto grid is showing, so an edge drop materializes what the operator sees. */
  columns: number
  cap: number
}

function dropAtEnd(layout: SplitLayout, sessionId: string): SplitLayout {
  // The auto grid's trailing cell means "last", as it did in the flat grid: a member moves there.
  if (layout.auto && groupOfSession(layout, sessionId)) {
    return keepingFiles(layout, sessionId, (current) => appendSession(closeSession(current, sessionId), sessionId))
  }
  return appendSession(layout, sessionId)
}

/**
 * What a sidebar or pane drag does on release. An edge splits the group under the pointer in that
 * direction, the middle adds the session to that group as a tab, and the empty end of an auto
 * grid appends. Capacity is spent afterwards, never on the group that was dropped onto.
 */
export function applySplitDrop(layout: SplitLayout, sessionId: string, hit: SplitDropHit, context: SplitDropContext): SplitLayout {
  if (isFileTabId(sessionId)) return applyFileDrop(layout, sessionId, hit, context)
  const target = hit.groupId ? findGroup(layout, hit.groupId) : null
  if (!target || hit.region === 'end') return evictToCap(dropAtEnd(layout, sessionId), context.cap)
  if (hit.region === 'center') {
    // A pane dropped back onto itself (its chat, though a file of its group may be shown) only focuses.
    const own = target.activeTab === sessionId || paneSessionOf(target, layout.focusHistory) === sessionId
    const next = own ? focusSession(layout, sessionId) : placeTab(layout, target.id, sessionId)
    return evictToCap(next, context.cap, target.tabs)
  }
  return splitAt(layout, target, hit.region, sessionId, context)
}

/**
 * A file tab's drag (pane-tab-dnd.ts) released on the grid, the same three ways: an edge splits it
 * out as a pane of its own, the middle moves it into that group as a tab, and the empty end moves
 * it out to a group at the end. A file tab not in the layout is no drop: it came from a tab.
 */
function applyFileDrop(layout: SplitLayout, fileTabId: string, hit: SplitDropHit, context: SplitDropContext): SplitLayout {
  if (!groupOfSession(layout, fileTabId)) return layout
  const target = hit.groupId ? findGroup(layout, hit.groupId) : null
  if (!target || hit.region === 'end') return evictToCap(appendFileTab(layout, fileTabId), context.cap)
  if (hit.region === 'center') return evictToCap(placeTab(layout, target.id, fileTabId), context.cap, target.tabs)
  return splitAt(layout, target, hit.region, fileTabId, context)
}

/**
 * An edge drop. Dropping onto a pane counts as using it, so the target becomes the most recent
 * pane before the new one: when the split leaves a row too narrow for its minimums, fitToBox
 * (split-geometry.ts) folds the other panes before the one just dropped beside. A refused split
 * (a lone pane onto its own edge) returns the layout untouched, still unarranged if it was.
 */
function splitAt(layout: SplitLayout, target: LayoutGroup, side: SplitSide, sessionId: string, context: SplitDropContext): SplitLayout {
  const materialized = materializeLayout(focusSession(layout, target.activeTab), context.columns)
  const next = splitGroup(materialized, target.id, side, sessionId)
  return next === materialized ? layout : evictToCap(next, context.cap, target.tabs)
}

export interface SplitDropPreviewInput {
  layout: SplitLayout
  sessionId: string
  hit: SplitDropHit
  context: SplitDropContext
  gridRect: Rect
  viewport: { width: number; height: number }
  metrics: SplitMetrics
  pickerPaneKey: string | null
}

/**
 * The rectangle the dropped pane will occupy, found by laying out the layout the drop produces
 * with the keys the grid will then mount. The dropped session becomes the route's pane, so every
 * key is its own session (a file-only pane's, its file tab id), and the picker (if open) keeps its
 * reserved trailing slot, as in chat-grid-drop.tsx simulateChatGridDrop.
 */
export function previewSplitDrop(input: SplitDropPreviewInput): { layout: SplitLayout; rect: Rect } | null {
  const next = applySplitDrop(input.layout, input.sessionId, input.hit, input.context)
  const visible = overflowForViewport(
    paneSetFromLayout(next),
    input.viewport.width,
    input.viewport.height,
    Number(Boolean(input.pickerPaneKey)),
  ).visible.sessionIds
  const keys = input.pickerPaneKey ? [...visible, input.pickerPaneKey] : visible
  const geometry = splitGeometry({
    layout: next,
    keys,
    sessionForKey: (key) => (key === input.pickerPaneKey ? null : key),
    box: input.gridRect,
    viewport: input.viewport,
    metrics: input.metrics,
  })
  const pane = geometry.panes.find((entry) => entry.key === input.sessionId)
  return pane ? { layout: next, rect: pane.rect } : null
}
