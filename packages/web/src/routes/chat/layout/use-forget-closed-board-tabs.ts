import { useEffect, useRef } from 'react'
import { clearSubBoardTabState } from '@/routes/todos/board/sub-board-tab-state'
import { groupsOf, type SplitLayout } from './split-layout'
import { parseTodoBoardTabId } from './tab-kind'

/** A sub-board tab's stored depth and filters go with the tab: closing it, however it closes (the strip, close all,
 * its chat's removal, eviction), abandons them, and a tab pinned for the same Todo later starts at the top. A tab
 * that merely moves between panes stays in the layout, so nothing is cleared for it. */
export function useForgetClosedBoardTabs(layout: SplitLayout) {
  const previous = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const open = new Set(groupsOf(layout).flatMap((group) => group.tabs).flatMap((id) => parseTodoBoardTabId(id) ?? []))
    for (const todoId of previous.current) if (!open.has(todoId)) clearSubBoardTabState(todoId)
    previous.current = open
  }, [layout])
}
