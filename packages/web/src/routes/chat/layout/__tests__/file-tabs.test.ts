import { describe, expect, it } from 'vitest'
import { fileTabId, fileTabTitle, isFileTabId, parseFileTabId } from '../file-tab'
import {
  appendSession,
  closeSession,
  createSplitLayout,
  focusSession,
  groupOfSession,
  groupsOf,
  isLastChatWithTabs,
  openDocTab,
  openInFocusedGroup,
  paneSessionForTab,
  placeTab,
  showTab,
  splitGroup,
  workingSetFromLayout,
} from '../split-layout'
import { hydrateSplitLayout } from '../use-split-working-set'
import { persistSplitLayout } from '../split-layout-storage'
import { applySplitDrop } from '../split-drop'
import { clearPaneTabDrag, tabOnlyDragId, hasPaneTabDrag, writePaneTabDrag } from '../pane-tab-dnd'
import { activeChatSessionDrag, hasChatSessionDrag, readChatSessionDrop } from '../../chat-session-dnd'

const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
const notes = fileTabId({ path: '/srv/work/notes.txt', sessionId: 'b' })

/** Two single-chat groups, `b` focused. */
const twoPanes = () => appendSession(createSplitLayout(['a'], 'a'), 'b')

describe('file tab ids', () => {
  it('round-trip a path and its session, and never look like a session', () => {
    expect(parseFileTabId(report)).toEqual({ path: 'docs/report.md', sessionId: 'a' })
    expect(parseFileTabId(fileTabId({ path: 'a b/c&d=e.md', sessionId: null }))).toEqual({ path: 'a b/c&d=e.md', sessionId: null })
    expect(isFileTabId(report)).toBe(true)
    expect(isFileTabId('3f2b9c1e-session')).toBe(false)
    expect(parseFileTabId('3f2b9c1e-session')).toBeNull()
    expect(fileTabTitle('/srv/work/notes.txt')).toBe('notes.txt')
  })
})

describe('openDocTab', () => {
  it('opens beside the chat that linked it, shown, with that chat still the pane', () => {
    const layout = openDocTab(twoPanes(), 'a', report)
    const owner = groupOfSession(layout, 'a')!
    expect(owner.tabs).toEqual(['a', report])
    expect(owner.activeTab).toBe(report)
    expect(layout.focusedGroupId).toBe(owner.id)
    // The working set, and so the URL and the pane keys, still see only chats.
    expect(workingSetFromLayout(layout)).toMatchObject({ sessionIds: ['a', 'b'], focusedId: 'a' })
  })

  it('falls back to the focused chat, shows a file already open, and needs a chat to sit beside', () => {
    const beside = openDocTab(twoPanes(), 'not-on-screen', notes)
    expect(groupOfSession(beside, 'b')!.tabs).toEqual(['b', notes])

    const elsewhere = focusSession(beside, 'a')
    const again = openDocTab(elsewhere, 'a', notes)
    expect(groupsOf(again).map((group) => group.tabs)).toEqual([['a'], ['b', notes]])
    expect(groupOfSession(again, 'b')!.activeTab).toBe(notes)

    const empty = createSplitLayout([])
    expect(openDocTab(empty, 'a', report)).toBe(empty)
    expect(openDocTab(twoPanes(), 'a', 'not-a-file-tab')).toEqual(twoPanes())
  })

  it('keeps the file shown when its chat is focused or navigated to; showTab switches back', () => {
    const layout = focusSession(openDocTab(twoPanes(), 'a', report), 'b')
    const refocused = focusSession(layout, 'a')
    expect(groupOfSession(refocused, 'a')!.activeTab).toBe(report)
    expect(refocused.focusedGroupId).toBe(groupOfSession(refocused, 'a')!.id)
    expect(groupOfSession(openInFocusedGroup(layout, 'a'), 'a')!.activeTab).toBe(report)

    expect(groupOfSession(showTab(layout, 'a'), 'a')!.activeTab).toBe('a')
  })

  it('switches away from the file for a different chat in the same group', () => {
    const base = createSplitLayout(['a'], 'a')
    const layout = openDocTab(placeTab(base, groupsOf(base)[0].id, 'x'), 'x', report)
    // x is the pane's chat under the file; a is the other chat in the group.
    expect(groupsOf(layout)[0].tabs).toEqual(['a', 'x', report])
    expect(groupOfSession(openDocTab(layout, 'a', notes), 'a')!.tabs).toEqual(['a', notes, 'x', report])
    expect(paneSessionForTab(layout, report)).toBe('x')
    expect(groupOfSession(focusSession(layout, 'a'), 'a')!.activeTab).toBe('a')
    expect(paneSessionForTab(layout, 'a')).toBe('a')
    expect(paneSessionForTab(layout, 'gone')).toBeNull()
  })
})

describe('file tabs in the layout', () => {
  it('are never opened as a chat: appending or opening one by id does nothing', () => {
    const layout = openDocTab(twoPanes(), 'a', report)
    expect(appendSession(layout, notes)).toBe(layout)
    expect(openInFocusedGroup(layout, notes)).toBe(layout)
  })

  it('close with their chat, and move to another chat like any tab', () => {
    const layout = openDocTab(twoPanes(), 'a', report)
    const closed = closeSession(layout, 'a')
    expect(groupsOf(closed).map((group) => group.tabs)).toEqual([['b']])

    const moved = placeTab(layout, groupOfSession(layout, 'b')!.id, report)
    expect(groupsOf(moved).map((group) => group.tabs)).toEqual([['a'], ['b', report]])
    expect(workingSetFromLayout(moved).sessionIds).toEqual(['a', 'b'])

    const fileClosed = closeSession(layout, report)
    expect(groupOfSession(fileClosed, 'a')!.tabs).toEqual(['a'])
    expect(groupOfSession(fileClosed, 'a')!.activeTab).toBe('a')
  })

  it('survive hydration against the live session list', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    persistSplitLayout(storage as Storage, openDocTab(twoPanes(), 'a', report))
    const restored = hydrateSplitLayout(storage, new Set(['a', 'b']), 4)
    expect(groupOfSession(restored, 'a')!.tabs).toEqual(['a', report])

    const chatDeleted = hydrateSplitLayout(storage, new Set(['b']), 4)
    expect(groupsOf(chatDeleted).map((group) => group.tabs)).toEqual([['b']])
  })
})

describe('dragging a file tab', () => {
  const transfer = () => {
    const data = new Map<string, string>()
    return {
      get types() { return [...data.keys()] },
      setData: (type: string, value: string) => { data.set(type, value) },
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: 'none',
    } as unknown as DataTransfer
  }

  it('is a tab drag only, never a chat-session drag other chat-drag consumers would route by', () => {
    const file = transfer()
    writePaneTabDrag(file, { groupId: 'g1', tabId: report })
    expect(hasPaneTabDrag(file)).toBe(true)
    expect(hasChatSessionDrag(file)).toBe(false)
    expect(activeChatSessionDrag()).toBeNull()
    // The pane surface finds it through the tab MIME instead, for a file and for nothing else.
    expect(tabOnlyDragId(file)).toBe(report)
    clearPaneTabDrag()
    expect(tabOnlyDragId(file)).toBeNull()

    const chat = transfer()
    writePaneTabDrag(chat, { groupId: 'g1', tabId: 'a' })
    expect(readChatSessionDrop(chat)).toBe('a')
    expect(tabOnlyDragId(chat)).toBeNull()
    clearPaneTabDrag()
  })

  it('a pane dropped back onto its own centre only focuses, the file staying shown', () => {
    const layout = focusSession(openDocTab(twoPanes(), 'a', report), 'b')
    const own = groupOfSession(layout, 'a')!
    const dropped = applySplitDrop(layout, 'a', { region: 'center', key: 'a', groupId: own.id }, { columns: 2, cap: 4 })
    expect(groupOfSession(dropped, 'a')).toMatchObject({ tabs: ['a', report], activeTab: report })
    expect(dropped.focusedGroupId).toBe(own.id)
  })

  it('is only a drop when it is a tab of the layout: a stale or unknown file changes nothing', () => {
    const layout = twoPanes()
    const context = { columns: 2, cap: 4 }
    expect(applySplitDrop(layout, report, { region: 'end', key: null, groupId: null }, context)).toBe(layout)
    expect(applySplitDrop(layout, report, { region: 'right', key: 'b', groupId: groupOfSession(layout, 'b')!.id }, context)).toBe(layout)
  })
})

describe('a group\'s only chat and its file tabs', () => {
  const single = () => openDocTab(createSplitLayout(['a'], 'a'), 'a', report)

  it('re-orders past its own file tabs', () => {
    const layout = single()
    const owner = groupsOf(layout)[0]
    const moved = placeTab(layout, owner.id, 'a', 1)
    expect(groupsOf(moved)[0]).toMatchObject({ tabs: [report, 'a'], activeTab: 'a' })
    expect(groupsOf(placeTab(moved, owner.id, 'a', 0))[0].tabs).toEqual(['a', report])
  })

  it('takes them along when it moves to another strip, a split edge or the end of the grid', () => {
    const layout = openDocTab(twoPanes(), 'a', report)
    const target = groupOfSession(layout, 'b')!

    const intoStrip = placeTab(layout, target.id, 'a', 0)
    expect(groupsOf(intoStrip).map((group) => group.tabs)).toEqual([['a', report, 'b']])
    expect(groupOfSession(intoStrip, 'a')!.activeTab).toBe('a')

    const split = splitGroup(layout, target.id, 'bottom', 'a')
    expect(groupOfSession(split, 'a')!.tabs).toEqual(['a', report])

    const end = applySplitDrop(layout, 'a', { region: 'end', key: null, groupId: null }, { columns: 2, cap: 4 })
    expect(groupsOf(end).map((group) => group.tabs)).toEqual([['b'], ['a', report]])
  })

  it('cannot split its own pane, which would leave its files nowhere', () => {
    const layout = single()
    expect(splitGroup(layout, groupsOf(layout)[0].id, 'right', 'a')).toBe(layout)
  })

  it('closing it closes them, and forgets them', () => {
    const closed = closeSession(openDocTab(twoPanes(), 'a', report), 'a')
    expect(groupsOf(closed).map((group) => group.tabs)).toEqual([['b']])
    expect(closed.focusHistory).toEqual(['b'])
  })
})

describe('isLastChatWithTabs', () => {
  it('holds only for the layout\'s only chat with file tabs beside it', () => {
    const lone = createSplitLayout(['a'], 'a')
    // A lone chat with no files closes as before (beside the new-chat picker, say).
    expect(isLastChatWithTabs(lone, 'a')).toBe(false)
    expect(isLastChatWithTabs(openDocTab(lone, 'a', report), 'a')).toBe(true)
    expect(isLastChatWithTabs(openDocTab(lone, 'a', report), report)).toBe(false)
    expect(isLastChatWithTabs(openDocTab(twoPanes(), 'a', report), 'a')).toBe(false)
    const twoChats = openDocTab(placeTab(lone, groupsOf(lone)[0].id, 'x'), 'a', report)
    expect(isLastChatWithTabs(twoChats, 'a')).toBe(false)
  })
})
