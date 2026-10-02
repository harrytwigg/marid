import { createContext, useContext, type ReactNode } from 'react'
import type { FileTabRef } from '@/routes/chat/layout/file-tab'

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
  /** The file this chat's pane is showing in place of the chat (a file tab of its group), if any. */
  shownFile: (sessionId: string) => FileTabRef | null
  /** False for the only chat on screen, whose file tabs would have nowhere to go. */
  closable: (sessionId: string) => boolean
}

export const PaneTabsContext = createContext<PaneTabsBinding | null>(null)

export function usePaneTabsStrip(sessionId: string): ReactNode | null {
  return useContext(PaneTabsContext)?.renderStrip(sessionId) ?? null
}

export function usePaneTabsShown(): boolean {
  return useContext(PaneTabsContext)?.hasStrips ?? false
}

const NO_KEEP = () => undefined

export function usePaneClosable(sessionId: string | null): boolean {
  const binding = useContext(PaneTabsContext)
  return !sessionId || !binding || binding.closable(sessionId)
}

export function usePaneShownFile(sessionId: string | null): FileTabRef | null {
  const binding = useContext(PaneTabsContext)
  return sessionId && binding ? binding.shownFile(sessionId) : null
}

export function usePaneTabsKeep(): (sessionId: string) => void {
  return useContext(PaneTabsContext)?.keep ?? NO_KEEP
}
