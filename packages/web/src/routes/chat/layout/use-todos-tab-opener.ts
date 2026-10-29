import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { openDocTab, type SplitLayout } from './split-layout'
import { TODOS_TAB_ID } from './tab-kind'

/**
 * The page's opener for the Todos board's tab: shown where it is open, else opened in the focused pane, or in
 * a pane of its own with none. It needs no chat to sit beside, so it opens on any layout; one asked for before
 * the stored layout has loaded waits for it, rather than land in a layout hydration is about to replace.
 */
export function useTodosTabOpener(
  hydrated: boolean,
  project: (layout: SplitLayout) => SplitLayout,
  setLayout: Dispatch<SetStateAction<SplitLayout>>,
) {
  const [waiting, setWaiting] = useState(false)
  const open = useCallback(() => {
    if (!hydrated) return setWaiting(true)
    setLayout((current) => openDocTab(project(current), null, TODOS_TAB_ID))
  }, [hydrated, project, setLayout])
  useEffect(() => {
    if (!hydrated || !waiting) return
    setWaiting(false)
    open()
  }, [hydrated, open, waiting])
  return open
}
