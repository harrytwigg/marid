import { describe, expect, it } from 'vitest'
import { fileTabId } from '../file-tab'
import { TODOS_TAB_ID, todoTabId } from '../tab-kind'
import {
  appendSession,
  closeSession,
  createSplitLayout,
  emptySplitLayout,
  evictToCap,
  findGroup,
  focusedGroup,
  groupOfSession,
  groupsOf,
  isLastChatWithTabs,
  normalizeLayout,
  openDocTab,
  placeTab,
  pruneSessions,
  replaceSession,
  routeSessionOf,
  showTab,
  splitGroup,
  workingSetFromLayout,
  type SplitLayout,
} from '../split-layout'
import { canCloseTab, closeAllUnpinned, closeUserTab, isPinned, pinTab, pinnedChats, unpinTab } from '../pinned-tabs'

const docA = todoTabId('T-1')
const docB = todoTabId('T-2')
const docC = fileTabId({ path: 'notes.md', sessionId: 'a' })

/** One group `[a, docA, docB, docC]`, chat `a` first (a document opens right after the chat it sits beside). */
function crowded(): SplitLayout {
  let layout = createSplitLayout(['a'], 'a')
  for (const doc of [docC, docB, docA]) layout = openDocTab(layout, 'a', doc)
  return layout
}

const tabsOf = (layout: SplitLayout, tabId: string) => groupOfSession(layout, tabId)?.tabs ?? []

describe('pinning and unpinning', () => {
  it('moves a pinned tab to the end of its group\'s pinned run', () => {
    let layout = crowded()
    expect(tabsOf(layout, 'a')).toEqual(['a', docA, docB, docC])
    layout = pinTab(layout, docB)
    expect(tabsOf(layout, 'a')).toEqual([docB, 'a', docA, docC])
    layout = pinTab(layout, docC)
    expect(tabsOf(layout, 'a')).toEqual([docB, docC, 'a', docA])
    expect(layout.pinned).toEqual([docB, docC])
    expect(isPinned(layout, docC)).toBe(true)
    expect(isPinned(layout, 'a')).toBe(false)
  })

  it('moves an unpinned tab to the start of the unpinned run', () => {
    let layout = pinTab(pinTab(pinTab(crowded(), docA), docB), docC)
    expect(tabsOf(layout, 'a')).toEqual([docA, docB, docC, 'a'])
    layout = unpinTab(layout, docA)
    expect(tabsOf(layout, 'a')).toEqual([docB, docC, docA, 'a'])
    expect(layout.pinned).toEqual([docB, docC])
  })

  it('pins any kind of tab, a chat included, and does nothing twice or for a tab that is not open', () => {
    const pinnedChat = pinTab(crowded(), 'a')
    expect(pinnedChat.pinned).toEqual(['a'])
    expect(pinTab(pinnedChat, 'a')).toBe(pinnedChat)
    expect(pinTab(pinnedChat, 'nope')).toBe(pinnedChat)
    expect(unpinTab(pinnedChat, docA)).toBe(pinnedChat)
    expect(unpinTab(pinnedChat, 'nope')).toBe(pinnedChat)
  })

  it('keeps a preview tab when it is pinned, and leaves another group tab\'s preview alone', () => {
    let layout = createSplitLayout(['a'], 'a')
    layout = openDocTab(layout, 'a', docA)
    const withPreview = { ...layout, root: { ...groupsOf(layout)[0], previewTab: docA } }
    const pinned = pinTab(withPreview, docA)
    expect(groupsOf(pinned)[0].previewTab).toBeUndefined()
    const other = pinTab({ ...withPreview, root: { ...groupsOf(layout)[0], previewTab: docA } }, 'a')
    expect(groupsOf(other)[0].previewTab).toBe(docA)
  })

  it('clamps a pinned tab dropped among unpinned ones to the end of the pinned run, and the reverse', () => {
    let layout = pinTab(pinTab(crowded(), docA), docB)
    expect(tabsOf(layout, 'a')).toEqual([docA, docB, 'a', docC])
    const group = groupOfSession(layout, 'a')!
    // Pinned docA dropped after docC: still in the pinned run, behind docB.
    layout = placeTab(layout, group.id, docA, 4)
    expect(tabsOf(layout, 'a')).toEqual([docB, docA, 'a', docC])
    // Unpinned docC dropped at the very front: lands right after the run.
    layout = placeTab(layout, group.id, docC, 0)
    expect(tabsOf(layout, 'a')).toEqual([docB, docA, docC, 'a'])
    // Pinned docB dropped first stays first.
    layout = placeTab(layout, group.id, docA, 0)
    expect(tabsOf(layout, 'a')).toEqual([docA, docB, docC, 'a'])
  })

  it('clamps the lone chat re-ordered among its documents', () => {
    let layout = pinTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), docA)
    layout = openDocTab(layout, 'a', docB)
    const group = groupOfSession(layout, 'a')!
    layout = placeTab(layout, group.id, 'a', 0)
    expect(tabsOf(layout, 'a')).toEqual([docA, 'a', docB])
  })

  it('keeps a pinned tab pinned when it moves to another group', () => {
    let layout = pinTab(appendSession(crowded(), 'b'), docA)
    const target = groupOfSession(layout, 'b')!
    layout = placeTab(layout, target.id, docA, 0)
    expect(groupOfSession(layout, docA)?.id).toBe(target.id)
    expect(tabsOf(layout, 'b')).toEqual([docA, 'b'])
    expect(layout.pinned).toEqual([docA])
    expect(tabsOf(layout, 'a')).toEqual(['a', docB, docC])
  })

  it('keeps a pinned tab pinned when it is split out to a pane of its own', () => {
    let layout = pinTab(crowded(), docA)
    layout = splitGroup(layout, groupOfSession(layout, 'a')!.id, 'right', docA)
    expect(groupsOf(layout)).toHaveLength(2)
    expect(layout.pinned).toEqual([docA])
  })

  it('restores the invariants on any layout handed to normalizeLayout', () => {
    const base = crowded()
    const messy = normalizeLayout({ ...base, pinned: [docB, 'gone', docB] })
    expect(messy.pinned).toEqual([docB, docB])
    expect(tabsOf(messy, 'a')).toEqual([docB, 'a', docA, docC])
  })

  it('closes a layout whose only anchor is unpinned with it', () => {
    let layout = openDocTab(emptySplitLayout(), null, docA)
    expect(layout.root).toBeNull()
    layout = pinTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), docA)
    layout = closeSession(layout, 'a')
    expect(groupsOf(layout).map((g) => g.tabs)).toEqual([[docA]])
    expect(unpinTab(layout, docA).root).toBeNull()
  })
})

describe('standalone tabs and the chat invariant', () => {
  it('opens the Todos tab in a layout with no chat, and shows it where it is already open', () => {
    const layout = openDocTab(emptySplitLayout(), null, TODOS_TAB_ID)
    expect(groupsOf(layout).map((g) => g.tabs)).toEqual([[TODOS_TAB_ID]])
    expect(focusedGroup(layout)?.activeTab).toBe(TODOS_TAB_ID)
    expect(workingSetFromLayout(layout).sessionIds).toEqual([])
    expect(routeSessionOf(groupsOf(layout)[0], layout.focusHistory)).toBe('')
    expect(openDocTab(layout, null, TODOS_TAB_ID)).toBe(layout)
  })

  it('still refuses any other document with no chat to sit beside', () => {
    expect(openDocTab(emptySplitLayout(), null, docA).root).toBeNull()
  })

  it('survives a layout of only the Todos tab, or of only a pinned document', () => {
    const todos = openDocTab(emptySplitLayout(), null, TODOS_TAB_ID)
    expect(normalizeLayout(todos).root).not.toBeNull()
    const pinnedOnly = closeSession(pinTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), docA), 'a')
    expect(groupsOf(normalizeLayout(pinnedOnly)).map((g) => g.tabs)).toEqual([[docA]])
  })

  it('does not take the Todos tab or a pinned document along when its chat closes', () => {
    let layout = openDocTab(openDocTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', TODOS_TAB_ID), 'a', docA), 'a', docB)
    layout = pinTab(layout, docB)
    layout = closeSession(layout, 'a')
    expect(groupsOf(layout).map((g) => g.tabs)).toEqual([[docB, TODOS_TAB_ID]])
    expect(layout.pinned).toEqual([docB])
  })

  it('leaves a standalone tab behind when a group\'s only chat moves, taking only the plain documents', () => {
    let layout = appendSession(openDocTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), 'a', TODOS_TAB_ID), 'b')
    layout = pinTab(layout, docA)
    const target = groupOfSession(layout, 'b')!
    layout = placeTab(layout, target.id, 'a', 1)
    expect(tabsOf(layout, 'b')).toEqual(['b', 'a'])
    expect(tabsOf(layout, docA)).toEqual([docA, TODOS_TAB_ID])
  })

  it('does not make the last chat unclosable for standalone tabs, but still for plain documents', () => {
    const withTodos = openDocTab(createSplitLayout(['a'], 'a'), 'a', TODOS_TAB_ID)
    expect(isLastChatWithTabs(withTodos, 'a')).toBe(false)
    const withPinned = pinTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), docA)
    expect(isLastChatWithTabs(withPinned, 'a')).toBe(false)
    expect(isLastChatWithTabs(openDocTab(withPinned, 'a', docB), 'a')).toBe(true)
  })

  it('closes a pinned chat along with the documents it owns, but not its standalone ones', () => {
    let layout = openDocTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), 'a', TODOS_TAB_ID)
    layout = pinTab(layout, 'a')
    layout = closeSession(layout, 'a')
    expect(groupsOf(layout).map((g) => g.tabs)).toEqual([[TODOS_TAB_ID]])
    expect(layout.pinned).toEqual([])
  })
})

describe('closing', () => {
  it('refuses a user close of a pinned tab, and lets a plain one go', () => {
    const layout = pinTab(crowded(), docA)
    expect(closeUserTab(layout, docA)).toBe(layout)
    expect(canCloseTab(layout, docA)).toBe(false)
    expect(canCloseTab(layout, docB)).toBe(true)
    expect(groupOfSession(closeUserTab(layout, docB), docB)).toBeNull()
    // The only chat beside plain documents is not closable either.
    expect(canCloseTab(layout, 'a')).toBe(false)
  })

  it('still closes a pinned chat for the system: a deleted session, a replacement', () => {
    const layout = pinTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'b')
    const pruned = pruneSessions(layout, (id) => id !== 'b')
    expect(groupOfSession(pruned, 'b')).toBeNull()
    expect(pruned.pinned).toEqual([])
    const replaced = replaceSession(layout, 'b', 'c')
    expect(groupOfSession(replaced, 'b')).toBeNull()
    expect(groupOfSession(replaced, 'c')).not.toBeNull()
    expect(isPinned(replaced, 'c')).toBe(false)
    expect(replaced.pinned).toEqual([])
  })

  it('keeps the order of a group whose pinned chat is replaced', () => {
    let layout = pinTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), 'a')
    layout = replaceSession(layout, 'a', 'z')
    expect(tabsOf(layout, 'z')).toEqual(['z', docA])
  })

  it('close all keeps the pinned tabs in their groups and drops the emptied ones', () => {
    let layout = pinTab(appendSession(crowded(), 'b'), docA)
    layout = pinTab(layout, 'b')
    layout = splitGroup(layout, groupOfSession(layout, 'a')!.id, 'bottom', 'c')
    const after = closeAllUnpinned(layout)
    expect(groupsOf(after).map((g) => g.tabs)).toEqual(expect.arrayContaining([[docA], ['b']]))
    expect(groupsOf(after)).toHaveLength(2)
    expect(after.pinned.sort()).toEqual([docA, 'b'].sort())
    expect(pinnedChats(after)).toEqual(['b'])
  })

  it('close all with a group showing a closed tab falls back to its most recent pinned tab', () => {
    let layout = pinTab(pinTab(crowded(), docA), docB)
    layout = showTab(showTab(layout, docB), docA)
    layout = showTab(layout, docC)
    const after = closeAllUnpinned(layout)
    expect(groupsOf(after)[0].tabs).toEqual([docA, docB])
    expect(groupsOf(after)[0].activeTab).toBe(docA)
    expect(focusedGroup(after)).not.toBeNull()
  })

  it('close all with nothing pinned is the empty layout', () => {
    expect(closeAllUnpinned(crowded())).toEqual(emptySplitLayout())
  })

  it('close all falls back focus by recency when the focused group closes', () => {
    let layout = pinTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'a')
    layout = showTab(layout, 'b')
    expect(focusedGroup(layout)?.activeTab).toBe('b')
    const after = closeAllUnpinned(layout)
    expect(focusedGroup(after)?.activeTab).toBe('a')
  })
})

describe('eviction', () => {
  it('skips a group holding a pinned tab while another can go', () => {
    let layout = appendSession(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'c')
    layout = pinTab(layout, 'a')
    layout = showTab(layout, 'c')
    const evicted = evictToCap(layout, 2)
    expect(groupsOf(evicted).map((g) => g.tabs[0]).sort()).toEqual(['a', 'c'])
  })

  it('evicts a pinned group once nothing else can go', () => {
    let layout = pinTab(pinTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'a'), 'b')
    layout = showTab(layout, 'b')
    const evicted = evictToCap(layout, 1)
    expect(groupsOf(evicted).map((g) => g.tabs[0])).toEqual(['b'])
  })

  it('can evict the last chat\'s group when a standalone group keeps the layout open', () => {
    let layout = openDocTab(createSplitLayout(['a'], 'a'), 'a', TODOS_TAB_ID)
    layout = splitGroup(layout, groupsOf(layout)[0].id, 'right', TODOS_TAB_ID)
    layout = showTab(layout, TODOS_TAB_ID)
    expect(groupsOf(evictToCap(layout, 1)).map((g) => g.tabs)).toEqual([[TODOS_TAB_ID]])
  })

  it('keeps the only chat group when nothing else holds the layout open', () => {
    const layout = showTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'b')
    expect(findGroup(evictToCap(layout, 1), groupOfSession(layout, 'b')!.id)).not.toBeNull()
  })
})
