import { useLayoutEffect, useRef } from 'react'
import { groupsOf, type SplitLayout } from './split-layout'

/**
 * The chats a layout change brought forward by switching tabs: a group that was already there now
 * shows a tab it already held. A chat opened into a group, and a group that is new, are arrivals
 * and keep the motion an open has; a switch moves between chats that are already open.
 */
export function tabSwitchedIn(previous: SplitLayout | null, next: SplitLayout): ReadonlySet<string> {
  const switched = new Set<string>()
  if (!previous) return switched
  const before = new Map(groupsOf(previous).map((group) => [group.id, group]))
  for (const group of groupsOf(next)) {
    const was = before.get(group.id)
    if (was && was.activeTab !== group.activeTab && was.tabs.includes(group.activeTab)) switched.add(group.activeTab)
  }
  return switched
}

/**
 * `tabSwitchedIn` against the layout the last commit painted, read during the render that mounts
 * the switched-in pane. The set is only meaningful to a pane mounting in this render, so a pane
 * latches it rather than reading it again.
 */
export function useTabSwitchedIn(layout: SplitLayout): ReadonlySet<string> {
  const painted = useRef<SplitLayout | null>(null)
  const switched = tabSwitchedIn(painted.current, layout)
  useLayoutEffect(() => {
    painted.current = layout
  }, [layout])
  return switched
}
