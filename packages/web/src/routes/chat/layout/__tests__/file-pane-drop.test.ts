import { describe, expect, it } from 'vitest'
import { fileTabId } from '../file-tab'
import {
  appendFileTab,
  createSplitLayout,
  groupOfSession,
  groupsOf,
  materializeLayout,
  openFileTab,
  paneSetFromLayout,
  splitGroup,
  type SplitLayout,
} from '../split-layout'
import { applySplitDrop, previewSplitDrop } from '../split-drop'
import { splitGeometry } from '../split-geometry'

const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
const notes = fileTabId({ path: '/srv/work/notes.txt', sessionId: 'b' })
const context = { columns: 2, cap: 6 }

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

describe('applySplitDrop with a file tab', () => {
  it('splits it out of its group on an edge of any pane, and the chat pane keeps the chat', () => {
    const layout = chatsWithReport()
    const target = groupOfSession(layout, 'b')!
    for (const region of ['left', 'right', 'top', 'bottom'] as const) {
      const next = applySplitDrop(layout, report, { region, key: 'b', groupId: target.id }, context)
      expect(groupOfSession(next, report)!.tabs).toEqual([report])
      expect(groupOfSession(next, 'a')!.tabs).toEqual(['a'])
      expect(next.focusedGroupId).toBe(groupId(next, report))
    }
  })

  it('splits it from the edge of the very pane it is a tab of', () => {
    const layout = chatsWithReport()
    const own = groupOfSession(layout, 'a')!
    const next = applySplitDrop(layout, report, { region: 'left', key: 'a', groupId: own.id }, context)
    expect(tabsOf(next)).toEqual([[report], ['a'], ['b']])
  })

  it('moves it into the group under the pointer on a centre drop', () => {
    const layout = chatsWithReport()
    const next = applySplitDrop(layout, report, { region: 'center', key: 'b', groupId: groupId(layout, 'b') }, context)
    expect(tabsOf(next)).toHaveLength(2)
    expect(groupOfSession(next, report)!.tabs).toContain('b')
    expect(groupOfSession(next, 'a')!.tabs).toEqual(['a'])
  })

  it('moves it out to a group of its own at the empty end of an arranged grid, beside the focused pane', () => {
    const layout = chatsWithReport()
    const next = applySplitDrop(layout, report, { region: 'end', key: null, groupId: null }, context)
    expect(tabsOf(next)).toEqual([['a'], [report], ['b']])
    expect(groupOfSession(next, report)!.activeTab).toBe(report)
  })

  it('moves it out to the end of an unarranged grid too', () => {
    const auto = openFileTab(createSplitLayout(['a', 'b'], 'b'), 'a', report)
    expect(auto.auto).toBe(true)
    const next = applySplitDrop(auto, report, { region: 'end', key: null, groupId: null }, context)
    expect(tabsOf(next)).toEqual([['a'], ['b'], [report]])
  })

  it('leaves a lone file alone when it is dropped on its own centre or end', () => {
    const layout = reportSplitOut()
    const own = groupId(layout, report)
    expect(tabsOf(applySplitDrop(layout, report, { region: 'center', key: report, groupId: own }, context))).toEqual([['a'], [report], ['b']])
    expect(tabsOf(applySplitDrop(layout, report, { region: 'end', key: null, groupId: null }, context))).toEqual([['a'], [report], ['b']])
  })

  it('spends capacity afterwards, never on the pane it split', () => {
    const layout = chatsWithReport()
    const next = applySplitDrop(layout, report, { region: 'right', key: 'b', groupId: groupId(layout, 'b') }, { columns: 2, cap: 2 })
    expect(groupsOf(next)).toHaveLength(2)
    expect(groupOfSession(next, report)).not.toBeNull()
    expect(groupOfSession(next, 'b')).not.toBeNull()
  })

  it('appendFileTab refuses a tab that is no file or not in the layout', () => {
    const layout = chatsWithReport()
    expect(appendFileTab(layout, 'a')).toBe(layout)
    expect(appendFileTab(layout, notes)).toBe(layout)
  })
})

describe('geometry and previews for a file-only pane', () => {
  const viewport = { width: 1440, height: 900 }
  const box = { left: 100, top: 50, width: 1200, height: 800 }
  const metrics = { padding: 8, gap: 8 }

  it('places the file pane by its key beside the chats', () => {
    const layout = reportSplitOut()
    const keys = paneSetFromLayout(layout).sessionIds
    const placed = splitGeometry({ layout, keys, sessionForKey: (key) => (key.startsWith('file:') ? null : key), box, viewport, metrics })
    expect(placed.panes.map((pane) => pane.key)).toEqual(['a', report, 'b'])
    expect(placed.panes.every((pane) => pane.groupId !== null && pane.rect.width > 0)).toBe(true)
    const fileRect = placed.panes.find((pane) => pane.key === report)!.rect
    expect(fileRect.left).toBeGreaterThan(placed.panes[0].rect.left)
  })

  it('previews a centre drop as the pane whose group the file joins', () => {
    const layout = chatsWithReport()
    const target = groupId(layout, 'b')
    const preview = previewSplitDrop({
      layout,
      sessionId: report,
      hit: { region: 'center', key: 'b', groupId: target },
      context,
      gridRect: box,
      viewport,
      metrics,
      pickerPaneKey: null,
    })
    expect(preview).not.toBeNull()
    const placed = splitGeometry({ layout: preview!.layout, keys: ['a', 'b'], sessionForKey: (key) => key, box, viewport, metrics })
    expect(preview!.rect).toEqual(placed.panes.find((pane) => pane.key === 'b')!.rect)
  })

  it('previews the half of the target a dropped file will take, the pane that then lands', () => {
    const layout = chatsWithReport()
    const preview = previewSplitDrop({
      layout,
      sessionId: report,
      hit: { region: 'right', key: 'b', groupId: groupId(layout, 'b') },
      context,
      gridRect: box,
      viewport,
      metrics,
      pickerPaneKey: null,
    })
    expect(preview).not.toBeNull()
    expect(preview!.rect.width).toBeGreaterThan(0)
    expect(tabsOf(preview!.layout)).toEqual([['a'], ['b'], [report]])
  })
})
