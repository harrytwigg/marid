import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { clearSubBoardTabState, readSubBoardTabState, writeSubBoardTabState } from '@/routes/todos/board/sub-board-tab-state'
import { closeSession, createSplitLayout, groupsOf, placeTab, type SplitLayout } from '../split-layout'
import { openPinnedDocTab, unpinTab, closeUserTab } from '../pinned-tabs'
import { todoBoardTabId } from '../tab-kind'
import { useForgetClosedBoardTabs } from '../use-forget-closed-board-tabs'
import { useTodoBoardTabOpener } from '../use-todo-board-tab-opener'

const board = todoBoardTabId('ACM-7')
const tabsOf = (layout: SplitLayout) => groupsOf(layout).flatMap((group) => group.tabs)

describe('a sub-board tab\'s stored state goes with the tab', () => {
  beforeEach(() => {
    localStorage.clear()
    clearSubBoardTabState('ACM-7')
  })

  function host(initial: SplitLayout) {
    return renderHook(() => {
      const [layout, setLayout] = useState(initial)
      useForgetClosedBoardTabs(layout)
      return { layout, setLayout }
    })
  }

  it('clears it when the tab closes, whichever way the layout lost it', () => {
    const open = openPinnedDocTab(createSplitLayout(['a'], 'a'), board)
    const { result } = host(open)
    writeSubBoardTabState('ACM-7', { depth: 'all', search: 'status=open' })

    act(() => result.current.setLayout((current) => closeUserTab(unpinTab(current, board), board)))

    expect(tabsOf(result.current.layout)).not.toContain(board)
    expect(readSubBoardTabState('ACM-7')).toEqual({ depth: 'children', search: '' })
    expect(localStorage.getItem('jinn-sub-board-tab:ACM-7')).toBeNull()
  })

  it('keeps it when the chat beside a pinned board closes', () => {
    const open = openPinnedDocTab(createSplitLayout(['a'], 'a'), board)
    const { result } = host(open)
    writeSubBoardTabState('ACM-7', { depth: 'all', search: '' })
    act(() => result.current.setLayout((current) => closeSession(current, 'a')))
    expect(tabsOf(result.current.layout)).toEqual([board])
    expect(readSubBoardTabState('ACM-7').depth).toBe('all')
  })

  it('keeps it while the tab moves between panes', () => {
    const two = openPinnedDocTab(createSplitLayout(['a', 'b'], 'b'), board)
    const { result } = host(two)
    writeSubBoardTabState('ACM-7', { depth: 'all', search: 'x=1' })
    const target = groupsOf(two).find((group) => !group.tabs.includes(board))!
    act(() => result.current.setLayout((current) => placeTab(current, target.id, board)))
    expect(tabsOf(result.current.layout)).toContain(board)
    expect(readSubBoardTabState('ACM-7')).toEqual({ depth: 'all', search: 'x=1' })
  })

  it('does not clear what the first layout it sees already holds (a reload restoring the tab)', () => {
    writeSubBoardTabState('ACM-7', { depth: 'all', search: '' })
    host(openPinnedDocTab(createSplitLayout(['a'], 'a'), board))
    expect(readSubBoardTabState('ACM-7').depth).toBe('all')
  })
})

describe('the page\'s opener for a sub-board tab', () => {
  function opener(hydrated: boolean) {
    return renderHook(({ ready }) => {
      const [layout, setLayout] = useState(createSplitLayout(['a'], 'a'))
      const open = useTodoBoardTabOpener(ready, (current) => current, setLayout)
      return { layout, open }
    }, { initialProps: { ready: hydrated } })
  }

  it('opens and pins the tab', () => {
    const { result } = opener(true)
    act(() => result.current.open('ACM-7'))
    expect(tabsOf(result.current.layout)).toContain(board)
    expect(result.current.layout.pinned).toEqual([board])
  })

  it('holds a request made before the stored layout has loaded, and applies it once it has', () => {
    const { result, rerender } = opener(false)
    act(() => result.current.open('ACM-7'))
    expect(tabsOf(result.current.layout)).not.toContain(board)
    rerender({ ready: true })
    expect(tabsOf(result.current.layout)).toContain(board)
    expect(result.current.layout.pinned).toEqual([board])
  })

  it('shows the tab already open and does not open a second', () => {
    const { result } = opener(true)
    act(() => result.current.open('ACM-7'))
    act(() => result.current.open('ACM-7'))
    expect(tabsOf(result.current.layout).filter((id) => id === board)).toHaveLength(1)
  })
})
