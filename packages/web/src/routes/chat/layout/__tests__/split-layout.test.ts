import { describe, expect, it } from 'vitest'
import { applyWorkingSetCap, createWorkingSet } from '../../working-set'
import {
  appendSession,
  closeSession,
  createSplitLayout,
  equalizeSplit,
  evictToCap,
  findGroup,
  groupOfSession,
  groupsOf,
  materializeLayout,
  moveHandle,
  createPreviewLayout,
  focusedGroupTabs,
  focusSession,
  emptySplitLayout,
  openInFocusedGroup,
  pinTab,
  placeTab,
  pruneSessions,
  replaceSession,
  setSplitSizes,
  splitGroup,
  workingSetFromLayout,
  type LayoutNode,
  type SplitLayout,
} from '../split-layout'
import { restoreSplitLayout, serializeSplitLayout } from '../split-layout-storage'

/** The tree as nested arrays of shown tabs: 'a' for a group, {row|column: [...]} for a split. */
type Shape = string | { row: Shape[] } | { column: Shape[] }
function shape(node: LayoutNode | null): Shape | null {
  if (!node) return null
  if (node.type === 'group') return node.tabs.length > 1 ? `${node.tabs.join('+')}@${node.activeTab}` : node.activeTab
  const children = node.children.map((child) => shape(child)!)
  return node.direction === 'row' ? { row: children } : { column: children }
}

function sizesOf(layout: SplitLayout): number[] {
  return layout.root?.type === 'split' ? layout.root.sizes.map((size) => Number(size.toFixed(4))) : []
}

function groupId(layout: SplitLayout, sessionId: string): string {
  return groupOfSession(layout, sessionId)!.id
}

/** row[a, b] arranged, focus b. */
function arrangedPair(): SplitLayout {
  return materializeLayout(createSplitLayout(['a', 'b'], 'b'), 2)
}

describe('split layout projection', () => {
  it('projects an unarranged layout to the same working set the upstream model would hold', () => {
    const layout = createSplitLayout(['a', 'b', 'c'], 'b')

    expect(layout.auto).toBe(true)
    expect(workingSetFromLayout(layout)).toEqual(createWorkingSet(['a', 'b', 'c'], 'b'))
  })

  it('projects one member per group: the shown tab, never the hidden ones', () => {
    let layout = arrangedPair()
    layout = placeTab(layout, groupId(layout, 'a'), 'c')

    expect(shape(layout.root)).toEqual({ row: ['a+c@c', 'b'] })
    expect(workingSetFromLayout(layout)).toMatchObject({ sessionIds: ['c', 'b'], focusedId: 'c' })
  })
})

describe('splitting', () => {
  it('adds a sibling along the parent axis and halves only the target', () => {
    let layout = arrangedPair()
    layout = splitGroup(layout, groupId(layout, 'b'), 'right', 'c')

    expect(shape(layout.root)).toEqual({ row: ['a', 'b', 'c'] })
    expect(sizesOf(layout)).toEqual([0.5, 0.25, 0.25])
    expect(workingSetFromLayout(layout).focusedId).toBe('c')
  })

  it('wraps the target in a split across the parent axis', () => {
    let layout = arrangedPair()
    layout = splitGroup(layout, groupId(layout, 'a'), 'top', 'c')

    expect(shape(layout.root)).toEqual({ row: [{ column: ['c', 'a'] }, 'b'] })
    expect(sizesOf(layout)).toEqual([0.5, 0.5])
  })

  it('moves a member instead of duplicating it, collapsing the split it leaves', () => {
    let layout = arrangedPair()
    layout = splitGroup(layout, groupId(layout, 'b'), 'bottom', 'c')
    expect(shape(layout.root)).toEqual({ row: ['a', { column: ['b', 'c'] }] })

    layout = splitGroup(layout, groupId(layout, 'a'), 'left', 'c')

    expect(shape(layout.root)).toEqual({ row: ['c', 'a', 'b'] })
    expect(groupsOf(layout).flatMap((g) => g.tabs).sort()).toEqual(['a', 'b', 'c'])
  })

  it('refuses to split a single-tab group with its own tab', () => {
    const layout = arrangedPair()

    expect(splitGroup(layout, groupId(layout, 'a'), 'right', 'a')).toBe(layout)
  })

  it('splits a tab out of its own group when the group holds others', () => {
    let layout = arrangedPair()
    layout = placeTab(layout, groupId(layout, 'a'), 'c')
    layout = splitGroup(layout, groupId(layout, 'c'), 'bottom', 'c')

    expect(shape(layout.root)).toEqual({ row: [{ column: ['a', 'c'] }, 'b'] })
  })

  it('arranges the layout, so geometry stops following the auto grid', () => {
    let layout = createSplitLayout(['a', 'b'], 'a')
    layout = splitGroup(layout, groupId(layout, 'a'), 'right', 'c')

    expect(layout.auto).toBe(false)
  })
})

describe('closing', () => {
  it('flattens a same-direction split left behind when its sibling closes', () => {
    let layout = arrangedPair()
    layout = splitGroup(layout, groupId(layout, 'b'), 'bottom', 'd')
    layout = splitGroup(layout, groupId(layout, 'b'), 'right', 'c')
    expect(shape(layout.root)).toEqual({ row: ['a', { column: [{ row: ['b', 'c'] }, 'd'] }] })

    layout = closeSession(layout, 'd')

    expect(shape(layout.root)).toEqual({ row: ['a', 'b', 'c'] })
    expect(sizesOf(layout)).toEqual([0.5, 0.25, 0.25])
  })

  it('returns focus to the most recently focused survivor', () => {
    let layout = materializeLayout(createSplitLayout(['a', 'b', 'c'], 'a'), 3)
    layout = openInFocusedGroup(layout, 'b')
    layout = openInFocusedGroup(layout, 'c')

    layout = closeSession(layout, 'c')

    expect(workingSetFromLayout(layout).focusedId).toBe('b')
  })

  it('shows the most recently focused remaining tab when the shown one closes', () => {
    let layout = arrangedPair()
    const left = groupId(layout, 'a')
    layout = placeTab(layout, left, 'c')
    layout = placeTab(layout, left, 'd')
    layout = placeTab(layout, left, 'c')

    layout = closeSession(layout, 'c')

    expect(findGroup(layout, left)).toMatchObject({ tabs: ['a', 'd'], activeTab: 'd' })
  })

  it('drops back to auto once a single pane is left', () => {
    let layout = arrangedPair()
    layout = closeSession(layout, 'b')

    expect(layout.auto).toBe(true)
    expect(shape(layout.root)).toBe('a')
  })
})

describe('navigation and replacement', () => {
  it('opens a newcomer as the focused group\'s preview tab, beside the shown tab', () => {
    let layout = materializeLayout(createSplitLayout(['a', 'b', 'c'], 'b'), 3)
    layout = openInFocusedGroup(layout, 'x')

    const group = findGroup(layout, groupId(layout, 'x'))!
    expect(group).toMatchObject({ tabs: ['b', 'x'], activeTab: 'x', previewTab: 'x' })
    expect(groupsOf(layout)).toHaveLength(3)
    expect(workingSetFromLayout(layout).focusedId).toBe('x')
  })

  it('replaces the existing preview tab in its slot instead of adding another', () => {
    let layout = createSplitLayout(['a'], 'a')
    layout = openInFocusedGroup(layout, 'x')
    layout = openInFocusedGroup(layout, 'y')

    expect(findGroup(layout, groupId(layout, 'y'))).toMatchObject({ tabs: ['a', 'y'], activeTab: 'y', previewTab: 'y' })
  })

  it('leaves a pinned tab alone: the next open adds a new preview tab', () => {
    let layout = createSplitLayout(['a'], 'a')
    layout = pinTab(openInFocusedGroup(layout, 'x'), 'x')
    layout = openInFocusedGroup(layout, 'y')

    expect(findGroup(layout, groupId(layout, 'y'))).toMatchObject({ tabs: ['a', 'x', 'y'], previewTab: 'y' })
  })

  it('pins by clearing previewTab, and pinning a non-preview tab changes nothing', () => {
    const opened = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
    const pinned = pinTab(opened, 'x')
    expect(findGroup(pinned, groupId(pinned, 'x'))!.previewTab).toBeUndefined()
    expect(pinTab(pinned, 'x')).toBe(pinned)
    expect(pinTab(pinned, 'a')).toBe(pinned)
    expect(pinTab(pinned, 'nope')).toBe(pinned)
  })

  it('makes a preview tab ordinary when it is placed, re-ordered or moved', () => {
    const opened = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
    const gid = groupId(opened, 'x')
    const reordered = placeTab(opened, gid, 'x', 0)
    expect(findGroup(reordered, gid)).toMatchObject({ tabs: ['x', 'a'] })
    expect(findGroup(reordered, gid)!.previewTab).toBeUndefined()

    const split = splitGroup(opened, gid, 'right', 'x')
    expect(groupsOf(split).every((group) => group.previewTab === undefined)).toBe(true)
  })

  it('forgets the preview mark when the preview tab closes, and follows a swapped-in replacement', () => {
    const opened = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
    const closed = closeSession(opened, 'x')
    expect(findGroup(closed, groupId(closed, 'a'))!.previewTab).toBeUndefined()

    const swapped = replaceSession(opened, 'x', 'z')
    expect(findGroup(swapped, groupId(swapped, 'z'))).toMatchObject({ tabs: ['a', 'z'], previewTab: 'z' })
  })

  it('starts a route-opened chat as a lone preview tab that the next open replaces', () => {
    let layout = createPreviewLayout('a')
    expect(findGroup(layout, groupId(layout, 'a'))).toMatchObject({ tabs: ['a'], previewTab: 'a' })

    layout = openInFocusedGroup(layout, 'b')
    expect(findGroup(layout, groupId(layout, 'b'))).toMatchObject({ tabs: ['b'], previewTab: 'b' })
    expect(groupsOf(layout)).toHaveLength(1)

    layout = pinTab(layout, 'b')
    layout = openInFocusedGroup(layout, 'c')
    expect(findGroup(layout, groupId(layout, 'c'))).toMatchObject({ tabs: ['b', 'c'], previewTab: 'c' })
  })

  it('opens the first chat of an empty layout as a preview', () => {
    const layout = openInFocusedGroup(emptySplitLayout(), 'a')
    expect(findGroup(layout, groupId(layout, 'a'))!.previewTab).toBe('a')
  })

  it('names the focused group\'s tabs for the tab shortcuts only when it has a strip', () => {
    expect(focusedGroupTabs(createSplitLayout(['a'], 'a'))).toBeNull()
    expect(focusedGroupTabs(emptySplitLayout())).toBeNull()

    let layout = createSplitLayout(['a', 'b'], 'a')
    layout = openInFocusedGroup(layout, 'x')
    expect(focusedGroupTabs(layout)).toEqual({ tabs: ['a', 'x'], active: 'x' })
    // Focus on the other, single-tab group: no strip there, so nothing to act on.
    expect(focusedGroupTabs(focusSession(layout, 'b'))).toBeNull()
  })

  it('focuses a member instead of previewing it again', () => {
    const layout = openInFocusedGroup(createSplitLayout(['a', 'b'], 'a'), 'b')
    expect(groupsOf(layout)).toHaveLength(2)
    expect(groupsOf(layout).every((group) => group.previewTab === undefined)).toBe(true)
  })

  it('keeps a replacement that is already a member in its own slot', () => {
    let layout = materializeLayout(createSplitLayout(['a', 'b', 'c'], 'b'), 3)
    layout = replaceSession(layout, 'b', 'c')

    expect(shape(layout.root)).toEqual({ row: ['a', 'c'] })
    expect(workingSetFromLayout(layout).focusedId).toBe('c')
  })

  it('grows an auto layout\'s row but splits the focused group of an arranged one', () => {
    const auto = appendSession(createSplitLayout(['a', 'b'], 'a'), 'c')
    expect(auto.auto).toBe(true)
    expect(shape(auto.root)).toEqual({ row: ['a', 'b', 'c'] })

    const arranged = appendSession(arrangedPair(), 'c')
    expect(shape(arranged.root)).toEqual({ row: ['a', 'b', 'c'] })
    expect(sizesOf(arranged)).toEqual([0.5, 0.25, 0.25])
  })
})

describe('tabs', () => {
  it('moves a tab into another group and closes the group it emptied', () => {
    let layout = materializeLayout(createSplitLayout(['a', 'b', 'c'], 'c'), 3)
    layout = placeTab(layout, groupId(layout, 'a'), 'c', 0)

    expect(shape(layout.root)).toEqual({ row: ['c+a@c', 'b'] })
    expect(workingSetFromLayout(layout).focusedId).toBe('c')
  })

  it('reorders within a group', () => {
    let layout = arrangedPair()
    const left = groupId(layout, 'a')
    layout = placeTab(layout, left, 'c')
    layout = placeTab(layout, left, 'c', 0)

    expect(findGroup(layout, left)?.tabs).toEqual(['c', 'a'])
  })
})

describe('materializing', () => {
  it('turns the auto grid into row-major rows, the short row\'s gap going to its last pane', () => {
    const layout = materializeLayout(createSplitLayout(['a', 'b', 'c', 'd', 'e'], 'a'), 3)

    expect(layout.auto).toBe(false)
    expect(shape(layout.root)).toEqual({ column: [{ row: ['a', 'b', 'c'] }, { row: ['d', 'e'] }] })
    const lastRow = layout.root?.type === 'split' ? layout.root.children[1] : null
    expect(lastRow?.type === 'split' && lastRow.sizes.map((size) => Number(size.toFixed(4)))).toEqual([0.3333, 0.6667])
  })

  it('leaves an arranged layout untouched', () => {
    const layout = arrangedPair()

    expect(materializeLayout(layout, 1)).toBe(layout)
  })
})

describe('capacity', () => {
  it('evicts by group recency, like the upstream cap, and never the focused group', () => {
    const upstream = applyWorkingSetCap(createWorkingSet(['a', 'b', 'c', 'd'], 'd'), 2)
    const layout = evictToCap(createSplitLayout(['a', 'b', 'c', 'd'], 'd'), 2)

    expect(workingSetFromLayout(layout).sessionIds).toEqual(upstream.sessionIds)
  })

  it('spares a protected session, so a drop cannot evict the pane it split', () => {
    const layout = evictToCap(createSplitLayout(['a', 'b', 'c'], 'c'), 2, ['a'])

    expect(workingSetFromLayout(layout).sessionIds).toEqual(['a', 'c'])
  })

  it('prunes sessions that no longer exist', () => {
    let layout = arrangedPair()
    layout = placeTab(layout, groupId(layout, 'a'), 'gone')
    layout = pruneSessions(layout, (id) => id !== 'gone')

    expect(shape(layout.root)).toEqual({ row: ['a', 'b'] })
    expect(layout.focusHistory).not.toContain('gone')
  })
})

describe('sizes', () => {
  it('moves one handle, clamped to both neighbours\' minimums', () => {
    expect(moveHandle([0.25, 0.25, 0.5], 0, 0.1)).toEqual([0.35, 0.15000000000000002, 0.5])
    expect(moveHandle([0.25, 0.25, 0.5], 0, 0.4, [0.1, 0.1, 0.1])).toEqual([0.4, 0.09999999999999998, 0.5])
    expect(moveHandle([0.5, 0.5], 0, -1, [0.2, 0.2])).toEqual([0.2, 0.8])
  })

  it('normalizes set sizes and resets them to equal', () => {
    let layout = arrangedPair()
    const splitId = layout.root!.id
    layout = setSplitSizes(layout, splitId, [3, 1])
    expect(sizesOf(layout)).toEqual([0.75, 0.25])

    layout = equalizeSplit(layout, splitId)
    expect(sizesOf(layout)).toEqual([0.5, 0.5])
  })
})

describe('split layout storage', () => {
  it('round-trips an arranged layout', () => {
    let layout = arrangedPair()
    layout = splitGroup(layout, groupId(layout, 'b'), 'bottom', 'c')
    layout = placeTab(layout, groupId(layout, 'a'), 'd')

    expect(restoreSplitLayout(serializeSplitLayout(layout))).toEqual(layout)
  })

  it('drops duplicate sessions and never reissues an id already in the tree', () => {
    const raw = JSON.stringify({
      version: 1,
      auto: false,
      nextId: 1,
      focusedGroupId: 'g9',
      focusHistory: ['a', 'b'],
      root: {
        type: 'split', id: 's3', direction: 'row', sizes: [1, 1, 1],
        children: [
          { type: 'group', id: 'g7', tabs: ['a'], activeTab: 'a' },
          { type: 'group', id: 'g8', tabs: ['a', 'b'], activeTab: 'a' },
          { type: 'group', id: 'g9', tabs: [], activeTab: 'z' },
        ],
      },
    })

    const layout = restoreSplitLayout(raw)

    expect(shape(layout.root)).toEqual({ row: ['a', 'b'] })
    expect(layout.nextId).toBe(9)
    expect(workingSetFromLayout(layout).focusedId).toBe('b')
  })

  it('round-trips the preview tab and drops one that names no tab', () => {
    const layout = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
    const restored = restoreSplitLayout(serializeSplitLayout(layout))
    expect(findGroup(restored, groupId(restored, 'x'))!.previewTab).toBe('x')

    const stale = restoreSplitLayout(JSON.stringify({
      version: 1,
      auto: true,
      focusedGroupId: 'g1',
      focusHistory: ['a'],
      nextId: 2,
      root: { type: 'group', id: 'g1', tabs: ['a'], activeTab: 'a', previewTab: 'gone' },
    }))
    expect(findGroup(stale, 'g1')).toEqual({ type: 'group', id: 'g1', tabs: ['a'], activeTab: 'a' })
  })

  it('falls back to an empty layout for garbage or another version', () => {
    expect(restoreSplitLayout('{').root).toBeNull()
    expect(restoreSplitLayout(JSON.stringify({ version: 2, root: { type: 'group', id: 'g1', tabs: ['a'] } })).root).toBeNull()
  })
})
