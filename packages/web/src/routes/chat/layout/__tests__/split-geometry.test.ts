import { describe, expect, it } from 'vitest'
import { cellRectForIndex } from '../../grid-cells'
import { closeSession, createSplitLayout, focusSession, groupOfSession, groupsOf, materializeLayout, placeTab, setSplitSizes, setVisibleSplitSizes, splitGroup, type SplitLayout } from '../split-layout'
import {
  MIN_PANE_WIDTH,
  fitExtents,
  splitDropForPointer,
  splitGeometry,
  type GeometryInput,
} from '../split-geometry'
import { applySplitDrop, previewSplitDrop } from '../split-drop'
import { hydrateSplitLayout } from '../use-split-working-set'
import { SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout } from '../split-layout-storage'
import { WORKING_SET_STORAGE_KEY, serializeWorkingSet } from '../../working-set'
import { workingSetFromLayout } from '../split-layout'

const VIEWPORT = { width: 1440, height: 900 }
const BOX = { left: 100, top: 50, width: 1200, height: 800 }
const METRICS = { padding: 8, gap: 8 }

function geometry(layout: SplitLayout, keys = workingSetFromLayout(layout).sessionIds, extra: Partial<GeometryInput> = {}) {
  return splitGeometry({ layout, keys, sessionForKey: (key) => key, box: BOX, viewport: VIEWPORT, metrics: METRICS, ...extra })
}

function rectOf(layout: SplitLayout, key: string, keys?: string[]) {
  return geometry(layout, keys).panes.find((pane) => pane.key === key)!.rect
}

function groupId(layout: SplitLayout, sessionId: string): string {
  return groupOfSession(layout, sessionId)!.id
}

function arranged(ids: string[], sizes?: number[]): SplitLayout {
  const layout = materializeLayout(createSplitLayout(ids, ids[0]), ids.length)
  return sizes ? setSplitSizes(layout, layout.root!.id, sizes) : layout
}

describe('split geometry', () => {
  it('lays an unarranged layout out cell for cell like the upstream grid, holes included', () => {
    for (const count of [1, 2, 3, 5, 6]) {
      const ids = Array.from({ length: count }, (_, index) => `s${index}`)
      const { panes } = geometry(createSplitLayout(ids))
      panes.forEach((pane, index) => {
        expect(pane.rect).toEqual(cellRectForIndex(index, count, BOX, { w: VIEWPORT.width, h: VIEWPORT.height }, METRICS))
      })
    }
  })

  it('places arranged panes by their sizes, with a handle in each gutter', () => {
    const result = geometry(arranged(['a', 'b'], [0.625, 0.375]))

    // 1200 wide, 8px inset each side, one 8px gutter: 1176px shared 5:3.
    expect(result.panes.map((pane) => pane.rect)).toEqual([
      { left: 108, top: 58, width: 735, height: 784 },
      { left: 851, top: 58, width: 441, height: 784 },
    ])
    expect(result.handles).toHaveLength(1)
    expect(result.handles[0].rect).toEqual({ left: 843, top: 58, width: 8, height: 784 })
  })

  it('holds every pane at its minimum width when the stored share would starve it', () => {
    const extents = fitExtents([0.9, 0.1], 800, [MIN_PANE_WIDTH, MIN_PANE_WIDTH])

    expect(extents).toEqual([800 - MIN_PANE_WIDTH, MIN_PANE_WIDTH])
  })

  it('scales everything down together once even the minimums do not fit', () => {
    expect(fitExtents([0.5, 0.5], 300, [280, 120])).toEqual([210, 90])
  })

  it('gives a folded pane\'s space to its siblings', () => {
    const layout = arranged(['a', 'b', 'c'])
    const rect = rectOf(layout, 'a', ['a', 'b'])

    expect(rect.width).toBeCloseTo((1184 - 8) / 2)
  })

  it('offers no splitters while a narrower window has folded groups away', () => {
    const layout = createSplitLayout(['a', 'b', 'c'], 'a')

    expect(geometry(layout, ['a', 'b']).handles).toEqual([])
    expect(geometry(layout).handles.length).toBeGreaterThan(0)
  })

  it('folds the least recently focused panes when the window cannot give every pane its minimum', () => {
    // Four side by side need 4 x 340 + 3 gutters = 1384px; this grid offers 1184.
    let layout = arranged(['a', 'b', 'c', 'd'])
    layout = focusSession(focusSession(focusSession(layout, 'd'), 'c'), 'b')
    const result = geometry(layout)

    expect(result.panes.filter((pane) => pane.folded).map((pane) => pane.key)).toEqual(['a'])
    expect(result.panes.filter((pane) => !pane.folded).every((pane) => pane.rect.width >= MIN_PANE_WIDTH)).toBe(true)
    expect(result.handles).toHaveLength(2)
  })

  it('resizes a split with a folded child without losing the folded child\'s share', () => {
    let layout = arranged(['a', 'b', 'c'], [0.2, 0.4, 0.4])
    layout = setVisibleSplitSizes(layout, layout.root!.id, [groupId(layout, 'b'), groupId(layout, 'c')], [1, 3])

    expect(layout.root?.type === 'split' && layout.root.sizes.map((size) => Number(size.toFixed(4)))).toEqual([0.2, 0.2, 0.6])
  })

  it('puts a pane the layout does not hold (the picker) in a column on the right', () => {
    const layout = arranged(['a', 'b'])
    const result = geometry(layout, ['a', 'b', '__picker__:1'], { sessionForKey: (key) => (key.startsWith('__') ? null : key) })
    const picker = result.panes.find((pane) => pane.key === '__picker__:1')!

    expect(picker.rect.left + picker.rect.width).toBeCloseTo(BOX.left + BOX.width - METRICS.padding)
    expect(picker.rect.width).toBeCloseTo((1184 - 8) / 3)
  })
})

describe('drop hit-testing', () => {
  const panes = [{ key: 'a', groupId: 'g1', rect: { left: 0, top: 0, width: 400, height: 400 } }]
  const grid = { left: 0, top: 0, width: 1000, height: 400 }

  it('reads the edge quarters as splits and the middle as the group', () => {
    expect(splitDropForPointer({ x: 50, y: 200 }, panes, grid)?.region).toBe('left')
    expect(splitDropForPointer({ x: 350, y: 200 }, panes, grid)?.region).toBe('right')
    expect(splitDropForPointer({ x: 200, y: 50 }, panes, grid)?.region).toBe('top')
    expect(splitDropForPointer({ x: 200, y: 350 }, panes, grid)?.region).toBe('bottom')
    expect(splitDropForPointer({ x: 200, y: 200 }, panes, grid)).toEqual({ region: 'center', key: 'a', groupId: 'g1' })
  })

  it('aims a pointer in the gutter at the nearest pane\'s edge', () => {
    const pair = [
      ...panes,
      { key: 'b', groupId: 'g2', rect: { left: 408, top: 0, width: 400, height: 400 } },
    ]

    expect(splitDropForPointer({ x: 403, y: 200 }, pair, grid)).toEqual({ region: 'right', key: 'a', groupId: 'g1' })
    expect(splitDropForPointer({ x: 406, y: 200 }, pair, grid)).toEqual({ region: 'left', key: 'b', groupId: 'g2' })
  })

  it('measures regions above the composer, so a stacked pane keeps a reachable bottom band', () => {
    // A 438px pane whose composer covers its lowest 120px: on the whole pane the bottom quarter
    // (y >= 328) is nearly all composer; above it the band starts at y = 238.5.
    const stacked = [{ key: 'a', groupId: 'g1', rect: { left: 0, top: 0, width: 400, height: 438 }, hitRect: { left: 0, top: 0, width: 400, height: 318 } }]
    const tall = { left: 0, top: 0, width: 1000, height: 438 }

    expect(splitDropForPointer({ x: 200, y: 280 }, stacked, tall)?.region).toBe('bottom')
    expect(splitDropForPointer({ x: 200, y: 200 }, stacked, tall)?.region).toBe('center')
    expect(splitDropForPointer({ x: 200, y: 30 }, stacked, tall)?.region).toBe('top')
  })

  it('calls empty grid space the end and ignores points outside the grid', () => {
    expect(splitDropForPointer({ x: 700, y: 200 }, panes, grid)?.region).toBe('end')
    expect(splitDropForPointer({ x: 1200, y: 200 }, panes, grid)).toBeNull()
  })
})

describe('applying a drop', () => {
  const context = { columns: 2, cap: 6 }

  it('splits the auto grid the operator sees, not a flat row', () => {
    const layout = createSplitLayout(['a', 'b', 'c', 'd'], 'a')
    const target = groupOfSession(layout, 'd')!.id

    const next = applySplitDrop(layout, 'x', { region: 'bottom', key: 'd', groupId: target }, context)

    expect(next.auto).toBe(false)
    // 2x2 grid: the bottom row is [c, d]; d splits downward in place.
    const bottomRow = next.root?.type === 'split' ? next.root.children[1] : null
    expect(bottomRow?.type === 'split' && bottomRow.children.map((child) => child.type)).toEqual(['group', 'split'])
  })

  it('adds a middle drop to the group as a tab', () => {
    const layout = arranged(['a', 'b'])
    const next = applySplitDrop(layout, 'x', { region: 'center', key: 'a', groupId: groupOfSession(layout, 'a')!.id }, context)

    expect(groupOfSession(next, 'x')?.tabs).toEqual(['a', 'x'])
    expect(workingSetFromLayout(next).sessionIds).toEqual(['x', 'b'])
  })

  it('spends capacity on someone other than the pane it split', () => {
    const layout = createSplitLayout(['a', 'b', 'c'], 'c')
    const next = applySplitDrop(layout, 'x', { region: 'right', key: 'a', groupId: groupOfSession(layout, 'a')!.id }, { columns: 3, cap: 3 })

    expect(workingSetFromLayout(next).sessionIds).toEqual(['a', 'x', 'c'])
  })

  it('leaves an unarranged layout unarranged when the split is refused', () => {
    const layout = createSplitLayout(['a', 'b', 'c'], 'a')

    const next = applySplitDrop(layout, 'a', { region: 'left', key: 'a', groupId: groupOfSession(layout, 'a')!.id }, context)

    expect(next).toBe(layout)
  })

  it('folds another pane, not the one dropped beside, when a split overfills its row', () => {
    // Four 340px panes do not fit 1184px; the least recent other than the target folds.
    const layout = arranged(['a', 'b', 'c'])
    const next = applySplitDrop(layout, 'x', { region: 'right', key: 'b', groupId: groupOfSession(layout, 'b')!.id }, { columns: 3, cap: 6 })
    const folded = geometry(next).panes.filter((pane) => pane.folded).map((pane) => pane.key)

    expect(folded).toHaveLength(1)
    expect(folded).not.toContain('b')
    expect(folded).not.toContain('x')
  })

  it('previews the half of the target the dropped pane will take, less the new gutter', () => {
    const layout = arranged(['a', 'b'])
    const preview = previewSplitDrop({
      layout,
      sessionId: 'x',
      hit: { region: 'bottom', key: 'b', groupId: groupOfSession(layout, 'b')!.id },
      context,
      gridRect: BOX,
      viewport: VIEWPORT,
      metrics: METRICS,
      pickerPaneKey: null,
    })

    // The new gutter comes out of every child's share, so the halves are a few pixels narrower
    // than a literal half; what matters is that the preview is the pane's real rectangle.
    const before = rectOf(layout, 'b')
    expect(preview!.rect.top + preview!.rect.height).toBeCloseTo(before.top + before.height)
    expect(Math.abs(preview!.rect.height - before.height / 2)).toBeLessThanOrEqual(METRICS.gap)
    expect(preview!.rect.width).toBe(before.width)
    expect(preview!.rect).toEqual(rectOf(preview!.layout, 'x'))
  })

  it('moves an arranged member through a split without changing who is on screen', () => {
    let layout = arranged(['a', 'b'])
    layout = splitGroup(layout, groupOfSession(layout, 'b')!.id, 'bottom', 'c')
    const next = applySplitDrop(layout, 'c', { region: 'left', key: 'a', groupId: groupOfSession(layout, 'a')!.id }, context)

    expect(new Set(workingSetFromLayout(next).sessionIds)).toEqual(new Set(['a', 'b', 'c']))
    expect(workingSetFromLayout(next).sessionIds[0]).toBe('c')
  })
})

describe('hydration', () => {
  function storage(values: Record<string, string>) {
    return { getItem: (key: string) => values[key] ?? null }
  }
  const live = new Set(['a', 'b', 'c'])

  it('keeps the arranged layout while the stored working set agrees with it', () => {
    const layout = arranged(['a', 'b'], [0.7, 0.3])
    const restored = hydrateSplitLayout(storage({
      [SPLIT_LAYOUT_STORAGE_KEY]: serializeSplitLayout(layout),
      [WORKING_SET_STORAGE_KEY]: serializeWorkingSet(workingSetFromLayout(layout)),
    }), live, 6)

    expect(restored).toEqual(layout)
  })

  it('rebuilds from the working set when something else rewrote it', () => {
    const layout = arranged(['a', 'b'], [0.7, 0.3])
    const restored = hydrateSplitLayout(storage({
      [SPLIT_LAYOUT_STORAGE_KEY]: serializeSplitLayout(layout),
      [WORKING_SET_STORAGE_KEY]: JSON.stringify({ version: 1, sessionIds: ['b', 'a', 'c'], focusedId: 'c', focusHistory: ['a', 'b', 'c'] }),
    }), live, 6)

    expect(restored.auto).toBe(true)
    expect(workingSetFromLayout(restored)).toMatchObject({ sessionIds: ['b', 'a', 'c'], focusedId: 'c' })
  })

  it('keeps the arrangement when a group\'s shown tab was deleted while the page was closed', () => {
    let layout = arranged(['a', 'b'])
    layout = splitGroup(layout, groupOfSession(layout, 'b')!.id, 'bottom', 'c')
    layout = placeTab(layout, groupOfSession(layout, 'a')!.id, 'x')
    const restored = hydrateSplitLayout(storage({
      [SPLIT_LAYOUT_STORAGE_KEY]: serializeSplitLayout(layout),
      [WORKING_SET_STORAGE_KEY]: serializeWorkingSet(workingSetFromLayout(layout)),
    }), live, 6)

    expect(restored.auto).toBe(false)
    expect(groupsOf(restored).map((group) => group.tabs)).toEqual([['a'], ['b'], ['c']])
  })

  it('keeps the layout when the working-set key is simply absent', () => {
    const layout = arranged(['a', 'b'], [0.7, 0.3])

    expect(hydrateSplitLayout(storage({ [SPLIT_LAYOUT_STORAGE_KEY]: serializeSplitLayout(layout) }), live, 6)).toEqual(layout)
  })

  it('folds a layout wider than the current cap by recency instead of discarding it', () => {
    const layout = arranged(['a', 'b', 'c'])
    const restored = hydrateSplitLayout(storage({
      [SPLIT_LAYOUT_STORAGE_KEY]: serializeSplitLayout(layout),
      [WORKING_SET_STORAGE_KEY]: serializeWorkingSet(workingSetFromLayout(layout)),
    }), live, 2)

    expect(restored.auto).toBe(false)
    expect(workingSetFromLayout(restored).sessionIds).toHaveLength(2)
  })
})

describe('closing a pane with hidden tabs', () => {
  it('predicts the tab the pane falls back to, which the flat working set cannot see', () => {
    let layout = arranged(['s', 'y'])
    layout = placeTab(layout, groupOfSession(layout, 's')!.id, 't')
    layout = focusSession(layout, 's')

    // What use-split-working-set.ts afterRemove returns for the page to navigate to.
    expect(workingSetFromLayout(closeSession(layout, 's')).focusedId).toBe('t')
  })
})
