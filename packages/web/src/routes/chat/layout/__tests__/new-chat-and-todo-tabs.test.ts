import { describe, expect, it } from 'vitest'
import { fileTabId } from '../file-tab'
import {
  isChatTabId,
  isDocTabId,
  isNewChatTabId,
  newChatTabId,
  paneTabKind,
  parseDocTabId,
  parseNewChatTabId,
  parseTodoTabId,
  todoTabId,
} from '../tab-kind'
import {
  appendSession,
  appendTabPane,
  closeSession,
  createSplitLayout,
  focusSession,
  groupOfSession,
  groupsOf,
  isLastChatWithTabs,
  openDocTab,
  openInFocusedGroup,
  openNewChatTab,
  paneKeysFromLayout,
  paneSessionForTab,
  pruneSessions,
  replaceSession,
  routeSessionOf,
  showTab,
  splitGroup,
  workingSetFromLayout,
  type SplitLayout,
} from '../split-layout'
import { applySplitDrop } from '../split-drop'
import { paneTabItems } from '../pane-tab-ops'
import { clearPaneTabDrag, hasPaneTabDrag, tabOnlyDragId, writePaneTabDrag } from '../pane-tab-dnd'
import { hasChatSessionDrag } from '../../chat-session-dnd'

const todo = todoTabId('ACM-1')

/** Two single-chat groups, `b` focused. */
const twoPanes = () => appendSession(createSplitLayout(['a'], 'a'), 'b')

/** The new chat tab the layout holds, if any. */
function newChatOf(layout: SplitLayout): string {
  return groupsOf(layout).flatMap((group) => group.tabs).find(isNewChatTabId) ?? ''
}

describe('tab kinds', () => {
  it('tell every kind apart, and never take a session id for anything but a chat', () => {
    const file = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    const fresh = newChatTabId({ serial: 3, employee: null })
    expect([file, todo, fresh, '3f2b9c1e-session'].map(paneTabKind)).toEqual(['file', 'todo', 'new-chat', 'chat'])
    expect([file, todo, fresh, 'a'].map(isDocTabId)).toEqual([true, true, false, false])
    expect([file, todo, fresh, 'a'].map(isChatTabId)).toEqual([false, false, false, true])
  })

  it('round-trip a Todo id and a new chat (with and without its employee)', () => {
    expect(parseTodoTabId(todo)).toBe('ACM-1')
    expect(parseDocTabId(todo)).toEqual({ kind: 'todo', todoId: 'ACM-1' })
    expect(parseNewChatTabId(newChatTabId({ serial: 7, employee: 'Sam Lee' }))).toEqual({ serial: 7, employee: 'Sam Lee' })
    expect(parseNewChatTabId(newChatTabId({ serial: 7, employee: null }))).toEqual({ serial: 7, employee: null })
    expect(parseTodoTabId('a')).toBeNull()
    expect(parseNewChatTabId('a')).toBeNull()
  })
})

describe('openNewChatTab', () => {
  it('opens a tab in the focused pane, shown, without splitting the grid or touching the route', () => {
    const before = twoPanes()
    const layout = openNewChatTab(before)
    const fresh = newChatOf(layout)
    expect(groupsOf(layout)).toHaveLength(2)
    expect(groupOfSession(layout, 'b')!.tabs).toEqual(['b', fresh])
    expect(groupOfSession(layout, 'b')!.activeTab).toBe(fresh)
    // The pane is now the new chat's; the working set, and so the URL, still name only chats.
    expect(paneKeysFromLayout(layout)).toEqual(['a', fresh])
    expect(workingSetFromLayout(layout)).toMatchObject({ sessionIds: ['a', 'b'], focusedId: 'b' })
  })

  it('shows the one already open for the same employee instead of stacking another', () => {
    const once = openNewChatTab(twoPanes())
    const twice = openNewChatTab(focusSession(once, 'a'))
    expect(groupsOf(twice).flatMap((group) => group.tabs).filter(isNewChatTabId)).toEqual([newChatOf(once)])
    expect(groupOfSession(twice, newChatOf(once))!.activeTab).toBe(newChatOf(once))

    const forSam = openNewChatTab(twice, 'Sam')
    expect(groupsOf(forSam).flatMap((group) => group.tabs).filter(isNewChatTabId)).toHaveLength(2)
  })

  it('needs a chat in the layout: the route composer is the new chat otherwise', () => {
    const empty = createSplitLayout([])
    expect(openNewChatTab(empty)).toBe(empty)
  })

  it('opens beside the route chat when a document-only pane is focused', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    const docPane = splitGroup(openDocTab(twoPanes(), 'b', report), groupOfSession(twoPanes(), 'a')!.id, 'right', report)
    const layout = openNewChatTab(docPane)
    expect(groupOfSession(layout, newChatOf(layout))!.tabs.some(isChatTabId)).toBe(true)
  })
})

describe('a new chat in the layout', () => {
  it('stays shown when the route lands on the chat under it (the projection on every render)', () => {
    const layout = openNewChatTab(twoPanes())
    const projected = openInFocusedGroup(layout, 'b')
    expect(groupOfSession(projected, 'b')!.activeTab).toBe(newChatOf(layout))
    expect(routeSessionOf(groupOfSession(projected, 'b')!, projected.focusHistory)).toBe('b')
  })

  it('becomes its chat in the same slot when its first send creates the session', () => {
    const opened = openNewChatTab(twoPanes())
    const fresh = newChatOf(opened)
    const layout = replaceSession(opened, fresh, 'e')
    expect(groupOfSession(layout, 'b')!.tabs).toEqual(['b', 'e'])
    expect(groupOfSession(layout, 'e')!.activeTab).toBe('e')
    expect(layout.focusedGroupId).toBe(groupOfSession(layout, 'e')!.id)
    expect(groupsOf(layout).flatMap((group) => group.tabs).some(isNewChatTabId)).toBe(false)
  })

  it('splits out to a pane of its own and back into a strip, as a dragged tab does', () => {
    const opened = openNewChatTab(twoPanes())
    const fresh = newChatOf(opened)
    const context = { columns: 2, cap: 4 }
    const out = applySplitDrop(opened, fresh, { region: 'right', key: 'a', groupId: groupOfSession(opened, 'a')!.id }, context)
    expect(groupsOf(out).map((group) => group.tabs)).toEqual([['a'], [fresh], ['b']])
    expect(paneKeysFromLayout(out)).toEqual(['a', fresh, 'b'])
    // Its own pane has no chat: the route stays where it was.
    expect(paneSessionForTab(out, fresh)).toBeNull()
    expect(workingSetFromLayout(out).sessionIds).toEqual(['a', 'b'])

    const back = applySplitDrop(out, fresh, { region: 'center', key: 'a', groupId: groupOfSession(out, 'a')!.id }, context)
    expect(groupsOf(back).map((group) => group.tabs)).toEqual([['a', fresh], ['b']])
  })

  it('keeps the last chat open beside it, and survives hydration pruning', () => {
    const lone = openNewChatTab(createSplitLayout(['a'], 'a'))
    expect(isLastChatWithTabs(lone, 'a')).toBe(true)
    const pruned = pruneSessions(openNewChatTab(twoPanes()), (id) => id !== 'a')
    expect(groupsOf(pruned).flatMap((group) => group.tabs).some(isNewChatTabId)).toBe(true)
  })

  it('is a tab drag only: it never carries the chat-session payload other drop targets route by', () => {
    const data = new Map<string, string>()
    const transfer = {
      get types() { return [...data.keys()] },
      setData: (type: string, value: string) => { data.set(type, value) },
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: 'none',
    } as unknown as DataTransfer
    const fresh = newChatTabId({ serial: 1, employee: null })
    writePaneTabDrag(transfer, { groupId: 'g1', tabId: fresh })
    expect(hasPaneTabDrag(transfer)).toBe(true)
    expect(hasChatSessionDrag(transfer)).toBe(false)
    expect(tabOnlyDragId(transfer)).toBe(fresh)
    clearPaneTabDrag()
  })

  it('is labelled New chat in its strip', () => {
    const layout = openNewChatTab(twoPanes())
    expect(paneTabItems(groupOfSession(layout, 'b')!, () => undefined).map((tab) => [tab.kind, tab.title])).toEqual([
      [undefined, 'Chat'],
      ['new-chat', 'New chat'],
    ])
  })
})

describe('a Todo tab', () => {
  it('opens beside the chat that mentioned it, and is labelled by its id', () => {
    const layout = openDocTab(twoPanes(), 'a', todo)
    expect(groupOfSession(layout, 'a')!.tabs).toEqual(['a', todo])
    expect(groupOfSession(layout, 'a')!.activeTab).toBe(todo)
    expect(paneSessionForTab(layout, todo)).toBe('a')
    expect(paneTabItems(groupOfSession(layout, 'a')!, () => undefined)[1]).toMatchObject({ kind: 'todo', title: 'ACM-1' })
  })

  it('opened again from anywhere, focuses the tab it already has instead of a duplicate', () => {
    const context = { columns: 2, cap: 4 }
    const opened = openDocTab(twoPanes(), 'a', todo)
    const ownPane = applySplitDrop(opened, todo, { region: 'bottom', key: 'b', groupId: groupOfSession(opened, 'b')!.id }, context)
    const again = openDocTab(focusSession(ownPane, 'a'), 'a', todo)
    expect(groupsOf(again).flatMap((group) => group.tabs).filter((id) => id === todo)).toHaveLength(1)
    expect(again.focusedGroupId).toBe(groupOfSession(again, todo)!.id)
    expect(groupOfSession(again, todo)!.tabs).toEqual([todo])
  })

  it('closes with the chat it sat beside, like a file', () => {
    const layout = closeSession(openDocTab(twoPanes(), 'a', todo), 'a')
    expect(groupOfSession(layout, todo)).toBeNull()
  })
})

describe('moving the layout\'s only chat', () => {
  const one = todoTabId('ACM-1')
  const two = todoTabId('ACM-2')

  /** The only chat beside two Todo panes and a new chat pane, unarranged. */
  function onlyChatAmongPanes(): SplitLayout {
    let layout = createSplitLayout(['a'], 'a')
    layout = appendTabPane(openDocTab(layout, 'a', one), one)
    layout = appendTabPane(openDocTab(layout, 'a', two), two)
    const opened = openNewChatTab(layout)
    return appendTabPane(opened, newChatOf(opened))
  }

  it('to the end of the grid moves it, never emptying the layout of the panes beside it', () => {
    const layout = onlyChatAmongPanes()
    const fresh = newChatOf(layout)
    const moved = applySplitDrop(layout, 'a', { region: 'end', key: null, groupId: null }, { columns: 3, cap: 6 })
    expect(groupsOf(moved).map((group) => group.tabs)).toEqual([[one], [two], [fresh], ['a']])
  })

  it('onto another pane\'s edge closes nothing, even in a window already over its cap', () => {
    const layout = onlyChatAmongPanes()
    const moved = applySplitDrop(layout, 'a', { region: 'right', key: two, groupId: groupOfSession(layout, two)!.id }, { columns: 3, cap: 2 })
    expect(groupsOf(moved).flatMap((group) => group.tabs).sort()).toEqual(['a', one, two, newChatOf(layout)].sort())
  })

  it('a drop that adds a pane closes at most one, the least recent', () => {
    const layout = onlyChatAmongPanes()
    const added = applySplitDrop(layout, 'b', { region: 'right', key: two, groupId: groupOfSession(layout, two)!.id }, { columns: 3, cap: 2 })
    expect(groupsOf(added)).toHaveLength(groupsOf(layout).length)
  })
})

it('a document dropped on the middle of the pane showing it keeps its strip order', () => {
  const one = todoTabId('ACM-1')
  const two = todoTabId('ACM-2')
  const layout = showTab(openDocTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', one), 'a', two), one)
  const group = groupOfSession(layout, one)!
  const dropped = applySplitDrop(layout, one, { region: 'center', key: 'a', groupId: group.id }, { columns: 1, cap: 4 })
  expect(groupOfSession(dropped, one)!.tabs).toEqual(group.tabs)
  expect(groupOfSession(dropped, one)!.activeTab).toBe(one)
})
