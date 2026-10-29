import { describe, expect, it } from 'vitest'
import { emptySplitLayout, groupsOf, openDocTab, openInFocusedGroup, openNewChatTab, createSplitLayout } from '../split-layout'
import { SPLIT_LAYOUT_STORAGE_KEY } from '../split-layout-storage'
import { isChatlessLayout, loadsChatless, routeChatForTodosOpen, todosTabFocused, todosTabOpen } from '../todos-tab'
import { TODOS_TAB_ID } from '../tab-kind'

const tabsOf = (layout: Parameters<typeof groupsOf>[0]) => groupsOf(layout).map((group) => group.tabs)
const withTodos = (layout = emptySplitLayout()) => openDocTab(layout, null, TODOS_TAB_ID)

describe('the Todos tab in a layout', () => {
  it('opens on an empty layout as a pane of its own, and is one tab however often it opens', () => {
    const once = withTodos()
    expect(tabsOf(once)).toEqual([[TODOS_TAB_ID]])
    expect(tabsOf(withTodos(once))).toEqual([[TODOS_TAB_ID]])
    expect(todosTabOpen(once)).toBe(true)
    expect(todosTabOpen(emptySplitLayout())).toBe(false)
  })

  it('opens in the focused pane of a layout that has one, over that pane\'s chat', () => {
    const layout = createSplitLayout(['a', 'b'], 'b')
    expect(tabsOf(withTodos(layout))).toEqual([['a'], ['b', TODOS_TAB_ID]])
    expect(routeChatForTodosOpen(layout)).toBe('b')
  })

  it('names no chat for the route when it gets a pane of its own', () => {
    expect(routeChatForTodosOpen(emptySplitLayout())).toBeNull()
    expect(routeChatForTodosOpen(withTodos())).toBeNull()
  })

  it('is focused only while the focused pane shows it', () => {
    const shown = withTodos(createSplitLayout(['a', 'b'], 'b'))
    expect(todosTabFocused(shown)).toBe(true)
    expect(todosTabFocused(openInFocusedGroup(shown, 'b'))).toBe(true) // focusing its chat keeps the tab shown over it
    expect(todosTabFocused(createSplitLayout(['a'], 'a'))).toBe(false)
    expect(todosTabFocused(emptySplitLayout())).toBe(false)
  })

  describe('a layout of standalone tabs only', () => {
    it('is chatless when no pane holds a chat, and not when one does or none exists', () => {
      expect(isChatlessLayout(withTodos())).toBe(true)
      expect(isChatlessLayout(withTodos(createSplitLayout(['a'], 'a')))).toBe(false)
      expect(isChatlessLayout(emptySplitLayout())).toBe(false)
    })

    it('puts a chat opened from the list in a pane beside the Todos pane, not inside it', () => {
      expect(tabsOf(openInFocusedGroup(withTodos(), 'a'))).toEqual([[TODOS_TAB_ID], ['a']])
    })

    it('puts a new chat in a pane of its own beside the Todos pane', () => {
      const next = openNewChatTab(withTodos())
      expect(tabsOf(next)).toEqual([[TODOS_TAB_ID], [expect.stringMatching(/^new:/)]])
      // Pressing New chat again shows that composer rather than stacking another.
      expect(tabsOf(openNewChatTab(next))).toEqual(tabsOf(next))
    })

    it('leaves a layout with nothing in it to the route\'s own composer', () => {
      const empty = emptySplitLayout()
      expect(openNewChatTab(empty)).toBe(empty)
    })
  })
})

describe('loading on a chatless layout', () => {
  const stored = (layout: object) => ({ getItem: (key: string) => (key === SPLIT_LAYOUT_STORAGE_KEY ? JSON.stringify(layout) : null) })
  const todosOnly = { version: 1, auto: false, focusedGroupId: 'g1', focusHistory: ['todos:'], nextId: 2, pinned: [], root: { type: 'group', id: 'g1', tabs: ['todos:'], activeTab: 'todos:' } }
  const withChat = { ...todosOnly, root: { type: 'group', id: 'g1', tabs: ['todos:', 'a'], activeTab: 'a' } }

  it('is true for a stored layout of standalone tabs on the bare route', () => {
    expect(loadsChatless('', stored(todosOnly))).toBe(true)
  })

  it('is false when the address names a chat, the layout holds one, or nothing is stored', () => {
    expect(loadsChatless('?session=a', stored(todosOnly))).toBe(false)
    expect(loadsChatless('', stored(withChat))).toBe(false)
    expect(loadsChatless('', { getItem: () => null })).toBe(false)
    expect(loadsChatless('', null)).toBe(false)
  })
})
