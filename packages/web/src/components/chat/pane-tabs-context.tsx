import { createContext, useContext, type ReactNode } from 'react'

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
}

export const PaneTabsContext = createContext<PaneTabsBinding | null>(null)

export function usePaneTabsStrip(sessionId: string): ReactNode | null {
  return useContext(PaneTabsContext)?.renderStrip(sessionId) ?? null
}

export function usePaneTabsShown(): boolean {
  return useContext(PaneTabsContext)?.hasStrips ?? false
}

const NO_KEEP = () => undefined

export function usePaneTabsKeep(): (sessionId: string) => void {
  return useContext(PaneTabsContext)?.keep ?? NO_KEEP
}
