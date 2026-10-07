import { createContext, useContext, type DragEvent, type ReactNode } from 'react'
import type { DocTabRef } from '@/routes/chat/layout/tab-kind'

/**
 * How a pane's title bar gets its tab strip without ChatPane threading it through: whoever owns
 * the layout provides a renderer, and the title bar asks it for the strip of the pane it is in.
 */
export interface PaneTabsBinding {
  renderStrip: (sessionId: string) => ReactNode | null
  /** Whether any pane has a strip to show, so single-group layouts with tabs still get a title bar. */
  hasStrips: boolean
  /** The operator is working in this chat: keep its tab if it is a preview. */
  keep: (sessionId: string) => void
  /** The document this pane is showing in place of its chat (a file or Todo tab of its group), if any. */
  shownDoc: (paneTabId: string) => DocTabRef | null
  /** False for the layout's only chat when other tabs sit beside it: they would have nowhere to go. */
  closable: (sessionId: string) => boolean
  /** The body of a document-only pane (a document dragged out to a pane of its own), by its pane key. */
  renderDocPane?: (paneKey: string) => ReactNode | null
  /** For a pane holding one tab, which shows no strip: its title bar drags that tab, as its strip
   *  would. Null when the pane has a strip (its tabs are dragged there) or is not in the layout. */
  titleDrag?: (paneTabId: string) => PaneTitleDrag | null
}

export interface PaneTitleDrag {
  draggable: true
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
}

export const PaneTabsContext = createContext<PaneTabsBinding | null>(null)

/**
 * The layout tab a pane renders, when that is not its session: a new chat's composer has no session
 * yet, but its tab id finds its strip and the document shown over it. Null everywhere else, where the
 * pane's session id is its tab id.
 */
export const PaneTabIdContext = createContext<string | null>(null)

export function usePaneTabId(sessionId: string | null): string | null {
  return useContext(PaneTabIdContext) ?? sessionId
}

/** The strip of the pane a title bar sits in: by its session, or by its tab id for a new chat's. */
export function usePaneTabsStrip(sessionId: string): ReactNode | null {
  const tabId = useContext(PaneTabIdContext) ?? sessionId
  return useContext(PaneTabsContext)?.renderStrip(tabId) ?? null
}

/** The drag a lone pane's title bar carries in place of a strip (PaneTabsBinding.titleDrag), if any:
 *  never beside a strip, which a pane only has with more than one tab. */
export function usePaneTitleDrag(sessionId: string): PaneTitleDrag | null {
  const tabId = useContext(PaneTabIdContext) ?? sessionId
  return useContext(PaneTabsContext)?.titleDrag?.(tabId) ?? null
}

export function usePaneTabsShown(): boolean {
  return useContext(PaneTabsContext)?.hasStrips ?? false
}

const NO_KEEP = () => undefined

export function usePaneClosable(sessionId: string | null): boolean {
  const binding = useContext(PaneTabsContext)
  return !sessionId || !binding || binding.closable(sessionId)
}

export function usePaneShownDoc(paneTabId: string | null): DocTabRef | null {
  const binding = useContext(PaneTabsContext)
  return paneTabId && binding ? binding.shownDoc(paneTabId) : null
}

export function usePaneTabsKeep(): (sessionId: string) => void {
  return useContext(PaneTabsContext)?.keep ?? NO_KEEP
}

export function usePaneTabsDocPane(): (paneKey: string) => ReactNode | null {
  return useContext(PaneTabsContext)?.renderDocPane ?? NO_DOC_PANE
}

const NO_DOC_PANE = () => null
