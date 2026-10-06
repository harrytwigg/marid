import { describe, expect, it, vi } from 'vitest'
import { paneTabHandlers, paneTabItems, selectTab, tabsOfGroup, type PaneTabOps } from '../pane-tab-ops'
import { fileTabId } from '../file-tab'
import {
  closeSession, createSplitLayout, findGroup, focusSession, groupOfSession, groupsOf, openDocTab, openInFocusedGroup, pinTab, placeTab, showTab, splitGroup, type SplitLayout,
} from '../split-layout'

const lookup = (id: string) => ({ a: { title: 'Alpha', employee: 'op', status: 'running' as const } })[id as 'a']

/** The ops the way the layout hook wires them: each edit runs on the current layout. */
function drive(start: SplitLayout) {
  let layout = start
  const select = vi.fn((id: string) => { layout = focusSession(layout, id) })
  const ops: PaneTabOps = {
    get layout() { return layout },
    place: (groupId, id, index) => { layout = placeTab(layout, groupId, id, index) },
    close: (id) => { layout = closeSession(layout, id) },
    select,
    pin: (id) => { layout = pinTab(layout, id) },
  }
  return { get layout() { return layout }, ops, select }
}

function threeTabsInOneGroup() {
  let layout = createSplitLayout(['a'], 'a')
  const groupId = groupsOf(layout)[0].id
  layout = placeTab(placeTab(layout, groupId, 'b'), groupId, 'c')
  return { layout, groupId }
}

describe('paneTabItems', () => {
  it('maps a group to strip items, with a placeholder title for a session not yet in the list', () => {
    const { layout, groupId } = threeTabsInOneGroup()
    const items = paneTabItems(findGroup(layout, groupId)!, lookup)
    expect(items.map((item) => item.id)).toEqual(groupsOf(layout)[0].tabs)
    expect(items.find((item) => item.id === 'a')).toMatchObject({ title: 'Alpha', employee: 'op', status: 'running' })
    expect(items.find((item) => item.id === 'b')?.title).toBe('Chat')
  })

  it('marks only the group\'s preview tab', () => {
    const layout = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
    const items = paneTabItems(groupsOf(layout)[0], lookup)
    expect(items.map((item) => Boolean(item.preview))).toEqual([false, true])
  })

  it('is empty for a group that no longer exists', () => {
    expect(tabsOfGroup(createSplitLayout(['a'], 'a'), 'g-missing', lookup)).toEqual([])
  })
})

describe('paneTabHandlers', () => {
  it('re-orders within the group, shows the moved tab and follows it with the route', () => {
    const { layout, groupId } = threeTabsInOneGroup()
    const before = findGroup(layout, groupId)!.tabs
    const run = drive(layout)
    paneTabHandlers(groupId, run.ops).onReorder(before[0], before.length - 1)
    expect(findGroup(run.layout, groupId)!.tabs).toEqual([...before.slice(1), before[0]])
    expect(run.select).toHaveBeenCalledWith(before[0], expect.anything())
  })

  it('moves a tab in from another group, closing the group it leaves when that empties', () => {
    const start = createSplitLayout(['a', 'b'], 'a')
    const [first, second] = groupsOf(start)
    const run = drive(start)
    paneTabHandlers(first.id, run.ops).onMoveIn(second.id, 'b', 0)
    expect(groupsOf(run.layout)).toHaveLength(1)
    expect(findGroup(run.layout, first.id)!.tabs).toEqual(['b', 'a'])
    expect(findGroup(run.layout, first.id)!.activeTab).toBe('b')
  })

  it('adds a sidebar chat at the drop slot and shows it', () => {
    const { layout, groupId } = threeTabsInOneGroup()
    const run = drive(layout)
    paneTabHandlers(groupId, run.ops).onDropSession!('z', 1)
    const group = findGroup(run.layout, groupId)!
    expect(group.tabs[1]).toBe('z')
    expect(group.activeTab).toBe('z')
    expect(run.select).toHaveBeenCalledWith('z', expect.anything())
  })

  it('closes a tab by session id, whether or not it is the shown one', () => {
    const { layout, groupId } = threeTabsInOneGroup()
    const run = drive(layout)
    const handlers = paneTabHandlers(groupId, run.ops)
    handlers.onClose('a')
    expect(findGroup(run.layout, groupId)!.tabs).not.toContain('a')
    handlers.onClose('c')
    expect(findGroup(run.layout, groupId)!.tabs).toEqual(['b'])
  })

  it('activates and pins by session id', () => {
    const start = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
    const groupId = groupsOf(start)[0].id
    const run = drive(start)
    const handlers = paneTabHandlers(groupId, run.ops)
    handlers.onActivate('a')
    expect(run.select).toHaveBeenCalledWith('a')
    handlers.onPin!('x')
    expect(findGroup(run.layout, groupId)!.previewTab).toBeUndefined()
  })

  it('drags a tab out to a pane edge as a split, which the model already handles', () => {
    const { layout, groupId } = threeTabsInOneGroup()
    const split = splitGroup(layout, groupId, 'right', 'b')
    expect(groupsOf(split)).toHaveLength(2)
    expect(findGroup(split, groupId)!.tabs).not.toContain('b')
  })
})

describe('paneTabHandlers routing (selectTab, as the provider wires it)', () => {
  /** Edits commit only when the test says so, as React state does: select sees the strip's layout. */
  function wired(start: SplitLayout) {
    let layout = start
    const route = vi.fn()
    const ops: PaneTabOps = {
      layout: start,
      place: (groupId, id, index) => { layout = placeTab(layout, groupId, id, index) },
      close: (id) => { layout = closeSession(layout, id) },
      select: (id, after = start) => selectTab(after, id, (tabId) => { layout = showTab(layout, tabId) }, route),
      pin: (id) => { layout = pinTab(layout, id) },
    }
    return { get layout() { return layout }, ops, route }
  }
  const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })

  it('routes to a sidebar chat dropped into a strip, though it was not in the layout yet', () => {
    const start = openDocTab(createSplitLayout(['a'], 'a'), 'a', report)
    const run = wired(start)
    paneTabHandlers(groupsOf(start)[0].id, run.ops).onDropSession!('n', 3)
    expect(run.route).toHaveBeenCalledWith('n')
    expect(groupOfSession(run.layout, 'n')!.activeTab).toBe('n')
  })

  it('routes a file moved into another strip to the chat of the pane it landed in', () => {
    const start = focusSession(openDocTab(createSplitLayout(['a', 'b'], 'a'), 'a', report), 'b')
    const target = groupOfSession(start, 'b')!
    const run = wired(start)
    paneTabHandlers(target.id, run.ops).onMoveIn(groupOfSession(start, 'a')!.id, report, 1)
    expect(run.route).toHaveBeenCalledWith('b')
    expect(findGroup(run.layout, target.id)).toMatchObject({ tabs: ['b', report], activeTab: report })
  })
})
