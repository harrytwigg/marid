import { describe, expect, it } from 'vitest'
import { fileTabId, fileTabTitle, isFileTabId, parseFileTabId } from '../file-tab'
import {
  appendSession,
  closeSession,
  createSplitLayout,
  focusSession,
  groupOfSession,
  groupsOf,
  openFileTab,
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
import { clearPaneTabDrag, hasPaneTabDrag, writePaneTabDrag } from '../pane-tab-dnd'
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

describe('openFileTab', () => {
  it('opens beside the chat that linked it, shown, with that chat still the pane', () => {
    const layout = openFileTab(twoPanes(), 'a', report)
    const owner = groupOfSession(layout, 'a')!
    expect(owner.tabs).toEqual(['a', report])
    expect(owner.activeTab).toBe(report)
    expect(layout.focusedGroupId).toBe(owner.id)
    // The working set, and so the URL and the pane keys, still see only chats.
    expect(workingSetFromLayout(layout)).toMatchObject({ sessionIds: ['a', 'b'], focusedId: 'a' })
  })

  it('falls back to the focused chat, shows a file already open, and needs a chat to sit beside', () => {
    const beside = openFileTab(twoPanes(), 'not-on-screen', notes)
    expect(groupOfSession(beside, 'b')!.tabs).toEqual(['b', notes])

    const elsewhere = focusSession(beside, 'a')
    const again = openFileTab(elsewhere, 'a', notes)
    expect(groupsOf(again).map((group) => group.tabs)).toEqual([['a'], ['b', notes]])
    expect(groupOfSession(again, 'b')!.activeTab).toBe(notes)

    const empty = createSplitLayout([])
    expect(openFileTab(empty, 'a', report)).toBe(empty)
    expect(openFileTab(twoPanes(), 'a', 'not-a-file-tab')).toEqual(twoPanes())
  })

  it('keeps the file shown when its chat is focused or navigated to; showTab switches back', () => {
    const layout = focusSession(openFileTab(twoPanes(), 'a', report), 'b')
    const refocused = focusSession(layout, 'a')
    expect(groupOfSession(refocused, 'a')!.activeTab).toBe(report)
    expect(refocused.focusedGroupId).toBe(groupOfSession(refocused, 'a')!.id)
    expect(groupOfSession(openInFocusedGroup(layout, 'a'), 'a')!.activeTab).toBe(report)

    expect(groupOfSession(showTab(layout, 'a'), 'a')!.activeTab).toBe('a')
  })

  it('switches away from the file for a different chat in the same group', () => {
    const base = createSplitLayout(['a'], 'a')
    const layout = openFileTab(placeTab(base, groupsOf(base)[0].id, 'x'), 'x', report)
    // x is the pane's chat under the file; a is the other chat in the group.
    expect(groupsOf(layout)[0].tabs).toEqual(['a', 'x', report])
    expect(groupOfSession(openFileTab(layout, 'a', notes), 'a')!.tabs).toEqual(['a', notes, 'x', report])
    expect(paneSessionForTab(layout, report)).toBe('x')
    expect(groupOfSession(focusSession(layout, 'a'), 'a')!.activeTab).toBe('a')
    expect(paneSessionForTab(layout, 'a')).toBe('a')
    expect(paneSessionForTab(layout, 'gone')).toBeNull()
  })
})

describe('file tabs in the layout', () => {
  it('never make a pane of their own', () => {
    const layout = openFileTab(twoPanes(), 'a', report)
    const target = groupOfSession(layout, 'b')!
    expect(splitGroup(layout, target.id, 'right', report)).toBe(layout)
    expect(appendSession(layout, notes)).toBe(layout)
    expect(openInFocusedGroup(layout, notes)).toBe(layout)
  })

  it('close with their chat, and move to another chat like any tab', () => {
    const layout = openFileTab(twoPanes(), 'a', report)
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
    persistSplitLayout(storage as Storage, openFileTab(twoPanes(), 'a', report))
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

  it('is a tab drag only, never a chat-session drag the pane surface would take', () => {
    const file = transfer()
    writePaneTabDrag(file, { groupId: 'g1', tabId: report })
    expect(hasPaneTabDrag(file)).toBe(true)
    expect(hasChatSessionDrag(file)).toBe(false)
    expect(activeChatSessionDrag()).toBeNull()
    clearPaneTabDrag()

    const chat = transfer()
    writePaneTabDrag(chat, { groupId: 'g1', tabId: 'a' })
    expect(readChatSessionDrop(chat)).toBe('a')
    clearPaneTabDrag()
  })

  it('cannot be dropped onto the pane surface, so it is never lost or routed to', () => {
    const layout = openFileTab(twoPanes(), 'a', report)
    const context = { columns: 2, cap: 4 }
    expect(applySplitDrop(layout, report, { region: 'end', key: null, groupId: null }, context)).toBe(layout)
    expect(applySplitDrop(layout, report, { region: 'right', key: 'b', groupId: groupOfSession(layout, 'b')!.id }, context)).toBe(layout)
  })
})
