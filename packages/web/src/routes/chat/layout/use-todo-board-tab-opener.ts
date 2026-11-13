import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { openPinnedDocTab } from './pinned-tabs'
import type { SplitLayout } from './split-layout'
import { todoBoardTabId } from './tab-kind'

/**
 * The page's opener for a Todo's sub-board tab: opened (or shown, where it is open) and pinned, in the focused pane,
 * or in a pane of its own with none. Like the Todos tab's opener it needs no chat to sit beside; one asked for
 * before the stored layout has loaded waits for it, rather than land in a layout hydration is about to replace.
 */
export function useTodoBoardTabOpener(
  hydrated: boolean,
  project: (layout: SplitLayout) => SplitLayout,
  setLayout: Dispatch<SetStateAction<SplitLayout>>,
) {
  const [waiting, setWaiting] = useState<string | null>(null)
  const open = useCallback((todoId: string) => {
    if (!hydrated) return setWaiting(todoId)
    setLayout((current) => openPinnedDocTab(project(current), todoBoardTabId(todoId)))
  }, [hydrated, project, setLayout])
  useEffect(() => {
    if (!hydrated || waiting === null) return
    setWaiting(null)
    open(waiting)
  }, [hydrated, open, waiting])
  return open
}
