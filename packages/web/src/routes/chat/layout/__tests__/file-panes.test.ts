import { describe, expect, it } from 'vitest'
import { fileTabId } from '../file-tab'
import {
  closeSession,
  createSplitLayout,
  evictToCap,
  focusSession,
  groupIdsByPaneKey,
  groupOfSession,
  groupsOf,
  isLastChatWithFiles,
  materializeLayout,
  openFileTab,
  paneKeyOf,
  paneKeysFromLayout,
  paneSetFromLayout,
  placeTab,
  pruneSessions,
  showTab,
  splitGroup,
  workingSetFromLayout,
  type SplitLayout,
} from '../split-layout'
import { hydrateSplitLayout } from '../use-split-working-set'
import { persistSplitLayout, restoreSplitLayout, serializeSplitLayout } from '../split-layout-storage'

const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
const notes = fileTabId({ path: '/srv/work/notes.txt', sessionId: 'b' })

const tabsOf = (layout: SplitLayout) => groupsOf(layout).map((group) => group.tabs)
const groupId = (layout: SplitLayout, tabId: string) => groupOfSession(layout, tabId)!.id

/** a and b, arranged, with the report open beside a. */
function chatsWithReport(): SplitLayout {
  const arranged = materializeLayout(createSplitLayout(['a', 'b'], 'b'), 2)
  return openFileTab(arranged, 'a', report)
}

/** chatsWithReport with the report split out to the right of a, so it is a pane of its own. */
function reportSplitOut(): SplitLayout {
  const layout = chatsWithReport()
  return splitGroup(layout, groupId(layout, 'a'), 'right', report)
}

describe('splitting a file tab out of its chat\'s group', () => {
  it('makes a file-only group beside the target, focused, and the chat keeps its own', () => {
    const layout = reportSplitOut()
    expect(tabsOf(layout)).toEqual([['a'], [report], ['b']])
    expect(groupOfSession(layout, report)!.activeTab).toBe(report)
    expect(layout.focusedGroupId).toBe(groupId(layout, report))
    expect(layout.auto).toBe(false)
  })

  it('works from every edge of the pane it came from', () => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const layout = chatsWithReport()
      const split = splitGroup(layout, groupId(layout, 'a'), side, report)
      expect(groupsOf(split).map((group) => group.tabs.join('+')).sort()).toEqual(['a', 'b', report].sort())
      expect(groupOfSession(split, 'a')!.tabs).toEqual(['a'])
    }
  })

  it('is refused for a lone file dropped on its own edge', () => {
    const layout = reportSplitOut()
    expect(splitGroup(layout, groupId(layout, report), 'right', report)).toBe(layout)
  })

  it('leaves the chat\'s pane showing the chat, not the file that went', () => {
    const layout = reportSplitOut()
    expect(groupOfSession(layout, 'a')).toMatchObject({ tabs: ['a'], activeTab: 'a' })
  })
})

describe('pane keys and the two projections', () => {
  it('keys a chat group by its chat and a file-only group by its file tab id', () => {
    const layout = reportSplitOut()
    expect(paneKeysFromLayout(layout)).toEqual(['a', report, 'b'])
    expect(groupIdsByPaneKey(layout).get(report)).toBe(groupId(layout, report))
    expect(paneKeyOf(groupOfSession(layout, report)!, layout.focusHistory)).toBe(report)
  })

  it('never lets a file key reach the working set: the route stays on a chat', () => {
    const layout = reportSplitOut()
    const set = workingSetFromLayout(layout)
    expect(set.sessionIds).toEqual(['a', 'b'])
    expect(set.focusHistory.every((id) => !id.startsWith('file:'))).toBe(true)
    // The file pane has focus, which has no chat: the most recent chat stands in.
    expect(['a', 'b']).toContain(set.focusedId)
    expect(set.focusedId).not.toBe(report)
  })

  it('gives the grid every pane, the focused file pane included', () => {
    const set = paneSetFromLayout(reportSplitOut())
    expect(set.sessionIds).toEqual(['a', report, 'b'])
    expect(set.focusedId).toBe(report)
    expect(set.focusHistory.at(-1)).toBe(report)
  })

  it('is the same working set as before for a layout with no file-only pane', () => {
    const layout = chatsWithReport()
    expect(paneSetFromLayout(layout)).toEqual(workingSetFromLayout(layout))
  })
})

describe('closing, moving and pruning around a file-only pane', () => {
  it('lets the file-only pane outlive the chat it was split from', () => {
    const closed = closeSession(reportSplitOut(), 'a')
    expect(tabsOf(closed)).toEqual([[report], ['b']])
  })

  it('takes a chat\'s own file tabs with it, but not another group\'s', () => {
    const layout = showTab(openFileTab(reportSplitOut(), 'b', notes), notes)
    expect(tabsOf(layout)).toEqual([['a'], [report], ['b', notes]])
    expect(tabsOf(closeSession(layout, 'b'))).toEqual([['a'], [report]])
  })

  it('closes the whole layout with its last chat, file panes and all', () => {
    const lone = openFileTab(createSplitLayout(['a'], 'a'), 'a', report)
    const wide = splitGroup(materializeLayout(openFileTab(lone, 'a', notes), 1), groupId(lone, 'a'), 'right', report)
    expect(tabsOf(wide)).toEqual([['a', notes], [report]])
    const closed = closeSession(wide, 'a')
    expect(closed.root).toBeNull()
    expect(groupsOf(closed)).toEqual([])
  })

  it('closing a file-only pane\'s tab closes the pane and leaves the chats', () => {
    const closed = closeSession(reportSplitOut(), report)
    expect(tabsOf(closed)).toEqual([['a'], ['b']])
    expect(closed.focusHistory).not.toContain(report)
  })

  it('moves a file back into a chat\'s strip, and the file pane goes', () => {
    const layout = reportSplitOut()
    const back = placeTab(layout, groupId(layout, 'a'), report, 1)
    expect(tabsOf(back)).toEqual([['a', report], ['b']])
    expect(groupOfSession(back, 'a')!.activeTab).toBe(report)
  })

  it('carries a lone chat\'s files along when it moves, without leaving them behind', () => {
    const lone = openFileTab(chatsWithReport(), 'a', notes)
    const moved = placeTab(lone, groupId(lone, 'b'), 'a', 0)
    expect(groupsOf(moved)).toHaveLength(1)
    expect(new Set(groupsOf(moved)[0].tabs)).toEqual(new Set(['a', 'b', report, notes]))
    expect(groupsOf(moved)[0].tabs.filter((id) => id === report)).toHaveLength(1)
  })

  it('keeps file ids when pruning against the live sessions, dropping only the dead chats', () => {
    const layout = reportSplitOut()
    const pruned = pruneSessions(layout, (id) => id === 'a')
    expect(tabsOf(pruned)).toEqual([['a'], [report]])
    expect(pruned.focusHistory).toContain(report)
    // Without the chat they sat beside, the lone chat's files go; a file-only pane stays while any chat does.
    expect(pruneSessions(layout, (id) => id !== 'a').root).not.toBeNull()
    expect(pruneSessions(layout, () => false).root).toBeNull()
  })
})

describe('isLastChatWithFiles with a file-only pane', () => {
  it('holds for the only chat while a file tab is open anywhere in the layout', () => {
    const lone = createSplitLayout(['a'], 'a')
    expect(isLastChatWithFiles(lone, 'a')).toBe(false)
    const layout = splitGroup(materializeLayout(openFileTab(lone, 'a', report), 1), groupId(lone, 'a'), 'right', report)
    expect(tabsOf(layout)).toEqual([['a'], [report]])
    expect(isLastChatWithFiles(layout, 'a')).toBe(true)
    expect(isLastChatWithFiles(layout, report)).toBe(false)
    expect(isLastChatWithFiles(reportSplitOut(), 'a')).toBe(false)
  })
})

describe('eviction with a file-only pane', () => {
  it('counts the file pane against the cap and evicts the least recently focused group', () => {
    let layout = reportSplitOut()
    layout = focusSession(layout, 'b')
    const evicted = evictToCap(layout, 2)
    // a was focused before the report was split out, so the report is more recent and a goes.
    expect(tabsOf(evicted)).toEqual([[report], ['b']])
  })

  it('never evicts the last chat group, which would close every file pane with it', () => {
    let layout = reportSplitOut()
    layout = closeSession(layout, 'a')
    layout = showTab(layout, report)
    const evicted = evictToCap(layout, 1)
    expect(groupOfSession(evicted, 'b')).not.toBeNull()
    expect(evicted.root).not.toBeNull()
  })
})

describe('a stored layout', () => {
  it('without a file-only pane loads as it did', () => {
    const layout = chatsWithReport()
    const restored = restoreSplitLayout(serializeSplitLayout(layout))
    expect(tabsOf(restored)).toEqual([['a', report], ['b']])
  })

  it('with a file-only pane round-trips, and hydrates against the live sessions', () => {
    const layout = reportSplitOut()
    expect(tabsOf(restoreSplitLayout(serializeSplitLayout(layout)))).toEqual([['a'], [report], ['b']])

    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    persistSplitLayout(storage as Storage, layout)
    expect(tabsOf(hydrateSplitLayout(storage, new Set(['a', 'b']), 6))).toEqual([['a'], [report], ['b']])
    expect(tabsOf(hydrateSplitLayout(storage, new Set(['b']), 6))).toEqual([[report], ['b']])
  })
})
