import { describe, expect, it } from 'vitest'
import {
  isChatTabId,
  isDocTabId,
  isTodoBoardTabId,
  paneTabKind,
  parseDocTabId,
  parseTodoBoardTabId,
  parseTodoTabId,
  todoBoardTabId,
  todoTabId,
} from '../tab-kind'
import { closeAllUnpinned, closeUserTab, isPinned, openPinnedDocTab, unpinTab } from '../pinned-tabs'
import { paneTabItems } from '../pane-tab-ops'
import { createSplitLayout, emptySplitLayout, groupsOf, openDocTab, closeSession } from '../split-layout'

const board = todoBoardTabId('ACM-7')
const tabsOf = (layout: Parameters<typeof groupsOf>[0]) => groupsOf(layout).map((group) => group.tabs)

describe('a Todo board tab id', () => {
  it('reads back as the Todo it shows, in its own namespace', () => {
    expect(board).toBe('todo-board:ACM-7')
    expect(isTodoBoardTabId(board)).toBe(true)
    expect(isDocTabId(board)).toBe(true)
    expect(isChatTabId(board)).toBe(false)
    expect(paneTabKind(board)).toBe('todo-board')
    expect(parseTodoBoardTabId(board)).toBe('ACM-7')
    expect(parseDocTabId(board)).toEqual({ kind: 'todo-board', todoId: 'ACM-7' })
  })

  it('is not the Todo\'s own tab, and neither reads as the other', () => {
    expect(parseTodoTabId(board)).toBeNull()
    expect(paneTabKind(todoTabId('ACM-7'))).toBe('todo')
    expect(parseTodoBoardTabId(todoTabId('ACM-7'))).toBeNull()
  })

  it('names no board when the id after the prefix is not a Todo id', () => {
    expect(parseTodoBoardTabId('todo-board:')).toBeNull()
    expect(parseTodoBoardTabId('todo-board:not-an-id')).toBeNull()
    expect(parseDocTabId('todo-board:nope')).toBeNull()
  })
})

describe('a Todo board tab in a layout', () => {
  it('opens beside the focused chat and pins, once however often it is asked for', () => {
    const layout = createSplitLayout(['a', 'b'], 'b')
    const once = openPinnedDocTab(layout, board)
    expect(tabsOf(once)).toEqual([['a'], [board, 'b']])
    expect(isPinned(once, board)).toBe(true)
    expect(openPinnedDocTab(once, board)).toEqual(once)
  })

  it('pins a board already open unpinned, rather than opening a second', () => {
    const open = openDocTab(createSplitLayout(['a'], 'a'), null, board)
    expect(isPinned(open, board)).toBe(false)
    const pinned = openPinnedDocTab(open, board)
    expect(isPinned(pinned, board)).toBe(true)
    expect(tabsOf(pinned).flat().filter((id) => id === board)).toHaveLength(1)
  })

  it('opens in a pane of its own on a layout with none, as the Todos board does', () => {
    expect(tabsOf(openPinnedDocTab(emptySplitLayout(), board))).toEqual([[board]])
  })

  it('is refused a user close until unpinned, survives Close all, and goes with unpinning when nothing else holds the layout', () => {
    const layout = openPinnedDocTab(createSplitLayout(['a'], 'a'), board)
    expect(closeUserTab(layout, board)).toBe(layout)
    expect(tabsOf(closeAllUnpinned(layout)).flat()).toEqual([board])
    const unpinned = unpinTab(layout, board)
    expect(isPinned(unpinned, board)).toBe(false)
    expect(tabsOf(closeUserTab(unpinned, board)).flat()).toEqual(['a'])
  })

  it('stays when the chat it sits beside closes, being pinned', () => {
    const layout = openPinnedDocTab(createSplitLayout(['a'], 'a'), board)
    expect(tabsOf(closeSession(layout, 'a')).flat()).toEqual([board])
  })

  it('shows in the strip as a board tab for its Todo', () => {
    const layout = openPinnedDocTab(createSplitLayout(['a'], 'a'), board)
    const [group] = groupsOf(layout)
    expect(paneTabItems(group, () => undefined, layout.pinned)).toContainEqual({ id: board, kind: 'todo-board', title: 'ACM-7', pinned: true, closable: false })
  })
})
