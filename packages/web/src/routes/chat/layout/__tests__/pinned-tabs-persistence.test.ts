import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY, serializeWorkingSet } from '../../working-set'
import { pinTab } from '../pinned-tabs'
import { appendSession, createSplitLayout, groupOfSession, groupsOf, openDocTab, workingSetFromLayout, type SplitLayout } from '../split-layout'
import { SPLIT_LAYOUT_STORAGE_KEY, restoreSplitLayout, serializeSplitLayout } from '../split-layout-storage'
import { TODOS_TAB_ID, todoTabId } from '../tab-kind'
import { hydrateSplitLayout, useSplitWorkingSet } from '../use-split-working-set'

const docA = todoTabId('T-1')
const docB = todoTabId('T-2')

/** `[a, docB, docA]` pinned: docA, plus a second group `b`. */
function pinnedLayout(): SplitLayout {
  let layout = createSplitLayout(['a'], 'a')
  layout = openDocTab(openDocTab(layout, 'a', docB), 'a', docA)
  return pinTab(appendSession(layout, 'b'), docA)
}

const tabsOf = (layout: SplitLayout) => groupsOf(layout).map((group) => group.tabs)

function storeRaw(patch: (stored: Record<string, unknown>) => void) {
  const stored = JSON.parse(serializeSplitLayout(pinnedLayout())) as Record<string, unknown>
  patch(stored)
  return JSON.stringify(stored)
}

afterEach(() => window.localStorage.clear())

describe('pinned tabs in storage', () => {
  it('persists the pinned tabs under the same version, and revives them in order', () => {
    const layout = pinnedLayout()
    const raw = serializeSplitLayout(layout)
    expect(JSON.parse(raw)).toMatchObject({ version: 1, pinned: [docA] })
    const restored = restoreSplitLayout(raw)
    expect(restored.pinned).toEqual([docA])
    expect(tabsOf(restored)).toEqual(tabsOf(layout))
    expect(tabsOf(restored)[0]).toEqual([docA, 'a', docB])
  })

  it('reads a layout stored before pinning as one with nothing pinned', () => {
    const restored = restoreSplitLayout(storeRaw((stored) => { delete stored.pinned }))
    expect(restored.pinned).toEqual([])
    expect(tabsOf(restored)[0]).toEqual([docA, 'a', docB])
  })

  it.each([
    ['a string', 'T-1'],
    ['an object', { 0: docA }],
    ['null', null],
    ['a number', 7],
  ])('treats %s in place of the pinned list as nothing pinned', (_name, value) => {
    expect(restoreSplitLayout(storeRaw((stored) => { stored.pinned = value })).pinned).toEqual([])
  })

  it('drops entries that are not strings, empty, duplicated, or not in the revived tree', () => {
    const restored = restoreSplitLayout(storeRaw((stored) => { stored.pinned = [docA, 7, null, '', docA, 'todo:gone', { id: docB }] }))
    expect(restored.pinned).toEqual([docA])
  })

  it('puts the pinned tabs first, each run in its stored order, in a group stored out of order', () => {
    const restored = restoreSplitLayout(storeRaw((stored) => { stored.pinned = [docB, docA] }))
    expect(tabsOf(restored)[0]).toEqual([docA, docB, 'a'])
  })

  it('revives a layout of only the Todos tab, or of only a pinned document', () => {
    const todosOnly = openDocTab(createSplitLayout([], null), null, TODOS_TAB_ID)
    expect(tabsOf(restoreSplitLayout(serializeSplitLayout(todosOnly)))).toEqual([[TODOS_TAB_ID]])
    const stored = JSON.parse(serializeSplitLayout(pinnedLayout())) as Record<string, unknown>
    stored.root = { type: 'group', id: 'g1', tabs: [docA], activeTab: docA }
    expect(tabsOf(restoreSplitLayout(JSON.stringify(stored)))).toEqual([[docA]])
  })

  it('unpins a chat deleted while the page was closed, and keeps what is pinned beside it', () => {
    let layout = pinTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', docA), 'a')
    layout = pinTab(layout, docA)
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout(layout))
    const hydrated = hydrateSplitLayout(window.localStorage, new Set(['b']), 4)
    expect(hydrated.pinned).toEqual([docA])
    expect(tabsOf(hydrated)).toEqual([[docA]])
  })

  it('keeps a pinned chat pinned when the stored working set disagrees and the layout is rebuilt from it', () => {
    const layout = pinTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'b')
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout(layout))
    // An older build wrote the working set with the order the other way round.
    window.localStorage.setItem(WORKING_SET_STORAGE_KEY, serializeWorkingSet({ sessionIds: ['b', 'a'], focusedId: 'a', focusHistory: ['b', 'a'] }))
    const hydrated = hydrateSplitLayout(window.localStorage, new Set(['a', 'b']), 4)
    expect(workingSetFromLayout(hydrated).sessionIds).toEqual(['b', 'a'])
    expect(hydrated.pinned).toEqual(['b'])
  })
})

describe('the layout hook with pinned tabs', () => {
  function storedWith(layout: SplitLayout) {
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout(layout))
    window.localStorage.setItem(WORKING_SET_STORAGE_KEY, serializeWorkingSet(workingSetFromLayout(layout)))
  }

  it('pins and unpins through its controls, and writes the pinned list back', () => {
    storedWith(appendSession(createSplitLayout(['a'], 'a'), 'b'))
    const { result } = renderHook(() => useSplitWorkingSet('a', [{ id: 'a' }, { id: 'b' }]))
    act(() => result.current.split.pin('b'))
    expect(result.current.split.layout.pinned).toEqual(['b'])
    expect(JSON.parse(window.localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? '{}').pinned).toEqual(['b'])
    act(() => result.current.split.unpin('b'))
    expect(result.current.split.layout.pinned).toEqual([])
  })

  it('refuses to close a pinned tab for the user, but still removes it for the system', () => {
    storedWith(pinTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'b'))
    const { result } = renderHook(() => useSplitWorkingSet('a', [{ id: 'a' }, { id: 'b' }]))
    act(() => result.current.split.close('b'))
    expect(groupOfSession(result.current.split.layout, 'b')).not.toBeNull()
    act(() => result.current.remove('b'))
    expect(groupOfSession(result.current.split.layout, 'b')).toBeNull()
    expect(result.current.split.layout.pinned).toEqual([])
  })

  it('closes every unpinned tab on close all, and the pinned ones stay', () => {
    storedWith(pinTab(appendSession(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'c'), 'b'))
    // The page leaves the URL when it closes all; the hook alone would open the route's chat again.
    const { result } = renderHook(() => useSplitWorkingSet(null, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]))
    act(() => result.current.split.closeAll())
    expect(tabsOf(result.current.split.layout)).toEqual([['b']])
    expect(result.current.split.layout.pinned).toEqual(['b'])
    expect(JSON.parse(window.localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? '{}').pinned).toEqual(['b'])
  })

  it('leaves no layout on close all when nothing is pinned', () => {
    storedWith(appendSession(createSplitLayout(['a'], 'a'), 'b'))
    const { result } = renderHook(() => useSplitWorkingSet(null, [{ id: 'a' }, { id: 'b' }]))
    act(() => result.current.split.closeAll())
    expect(result.current.split.layout.root).toBeNull()
  })
})
