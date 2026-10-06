import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileTabId } from '../layout/file-tab'
import { createSplitLayout, groupOfSession, materializeLayout, openDocTab, splitGroup, workingSetFromLayout } from '../layout/split-layout'
import { MAX_SIDEBAR_WIDTH } from '../sidebar-width'
import { storeSidebarWidth } from '../sidebar-width-store'
import { useChatGridState } from '../use-chat-grid-state'

const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })

/** The chats arranged, with the report split out beside the first. */
function withFilePane(ids: string[]) {
  const arranged = materializeLayout(createSplitLayout(ids, ids[0]), ids.length)
  const opened = openDocTab(arranged, ids[0], report)
  return splitGroup(opened, groupOfSession(opened, ids[0])!.id, 'right', report)
}

describe('the grid state with a file-only pane in the layout', () => {
  const original = { width: window.innerWidth, height: window.innerHeight }
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.height })
  })

  it('mounts the file pane beside the chats, which stay the only sessions it reports', () => {
    const layout = withFilePane(['a', 'b'])
    const { result } = renderHook(() => useChatGridState({
      committedId: 'a',
      workingSet: workingSetFromLayout(layout),
      sessions: [{ id: 'a' }, { id: 'b' }],
      layout,
    }))

    expect(result.current.gridPaneKeys).toEqual(['a', report, 'b'])
    expect(result.current.mountedSessionIds).toEqual(['a', 'b'])
    expect(result.current.focusedSessionId).not.toBe(report)
  })

  it('is exactly the working set when the layout holds no file-only pane', () => {
    const layout = materializeLayout(createSplitLayout(['a', 'b'], 'a'), 2)
    const { result } = renderHook(() => useChatGridState({
      committedId: 'a',
      workingSet: workingSetFromLayout(layout),
      sessions: [{ id: 'a' }, { id: 'b' }],
      layout,
    }))

    expect(result.current.gridPaneKeys).toEqual(['a', 'b'])
  })

  it('counts the file pane against the cap, so a narrower window folds a chat for it', () => {
    const ids = ['a', 'b', 'c', 'd']
    const layout = withFilePane(ids)
    const { result } = renderHook(() => useChatGridState({
      committedId: 'a',
      workingSet: workingSetFromLayout(layout),
      sessions: ids.map((id) => ({ id })),
      layout,
    }))
    expect(result.current.gridPaneKeys).toHaveLength(5)

    // The widest list leaves room for four panes at 1440: five (four chats and the file) no longer fit.
    act(() => storeSidebarWidth(MAX_SIDEBAR_WIDTH))
    expect(result.current.gridPaneKeys).toHaveLength(4)
    expect(result.current.gridPaneKeys).toContain(report)
    act(() => storeSidebarWidth(null))
  })

  it('shows a phone one chat and no file-only pane', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    const layout = withFilePane(['a', 'b'])
    const { result } = renderHook(() => useChatGridState({
      committedId: 'a',
      workingSet: workingSetFromLayout(layout),
      sessions: [{ id: 'a' }, { id: 'b' }],
      layout,
    }))

    expect(result.current.gridPaneKeys).toEqual(['a'])
  })
})
