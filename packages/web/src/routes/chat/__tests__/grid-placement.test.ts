import { describe, expect, it } from 'vitest'
import { placementForPointer, type GridRectangle } from '../grid-placement'

function rect(left: number, top: number, width: number, height: number): GridRectangle {
  return { left, top, width, height }
}

const gridRect = rect(0, 0, 400, 200)
const panes = [rect(0, 0, 200, 200), rect(200, 0, 200, 200)]

describe('chat grid pointer placement', () => {
  it.each([
    [{ x: 20, y: 100 }, 0, 'left', rect(0, 0, 100, 200)],
    [{ x: 180, y: 100 }, 1, 'right', rect(100, 0, 100, 200)],
    [{ x: 100, y: 20 }, 0, 'top', rect(0, 0, 200, 100)],
    [{ x: 100, y: 180 }, 1, 'bottom', rect(0, 100, 200, 100)],
  ] as const)('maps %o to index %i in the %s region', (point, targetIndex, region, previewRect) => {
    expect(placementForPointer(point, panes, gridRect)).toEqual({
      targetIndex,
      region,
      previewRect,
    })
  })

  it('uses deterministic quarter and half boundaries', () => {
    expect(placementForPointer({ x: 50, y: 100 }, panes, gridRect)?.region).toBe('left')
    expect(placementForPointer({ x: 150, y: 100 }, panes, gridRect)?.region).toBe('right')
    expect(placementForPointer({ x: 80, y: 50 }, panes, gridRect)?.region).toBe('left')
    expect(placementForPointer({ x: 100, y: 150 }, panes, gridRect)?.region).toBe('bottom')
    expect(placementForPointer({ x: 100, y: 100 }, panes, gridRect)?.region).toBe('right')
    expect(placementForPointer({ x: 20, y: 20 }, panes, gridRect)?.region).toBe('left')
  })

  it('gives exact pane boundaries to the next pane in DOM order', () => {
    expect(placementForPointer({ x: 200, y: 100 }, panes, gridRect)).toMatchObject({
      targetIndex: 1,
      region: 'left',
    })
  })

  it('supports a single pane and appends from trailing grid space', () => {
    const singlePane = [rect(0, 0, 300, 200)]

    expect(placementForPointer({ x: 290, y: 100 }, singlePane, gridRect)).toMatchObject({
      targetIndex: 1,
      region: 'right',
    })
    expect(placementForPointer({ x: 350, y: 100 }, singlePane, gridRect)).toEqual({
      targetIndex: 1,
      region: 'end',
      previewRect: rect(150, 0, 150, 200),
    })
  })

  it('uses the whole grid as the end preview when no panes exist', () => {
    expect(placementForPointer({ x: 200, y: 100 }, [], gridRect)).toEqual({
      targetIndex: 0,
      region: 'end',
      previewRect: gridRect,
    })
  })

  it.each([
    { x: -1, y: 100 },
    { x: 400, y: 100 },
    { x: 100, y: -1 },
    { x: 100, y: 200 },
  ])('returns no placement outside the half-open grid for $x,$y', (point) => {
    expect(placementForPointer(point, panes, gridRect)).toBeNull()
  })
})

describe('the grid\'s panes when the layout holds only standalone panes', () => {
  it('draws no route composer pane beside them', async () => {
    const { deriveChatGridIds } = await import('../grid-placement')
    const input = { sessionIds: ['todos:'], primaryPaneKey: '__new__:0:', primarySessionId: null }
    // Without the flag a lone pane is taken for the composer's place, and two are joined by one.
    expect(deriveChatGridIds(input)).toEqual(['__new__:0:'])
    expect(deriveChatGridIds({ ...input, sessionIds: ['todos:', 'todo:ACM-1'] })).toEqual(['todos:', 'todo:ACM-1', '__new__:0:'])
    expect(deriveChatGridIds({ ...input, chatless: true })).toEqual(['todos:'])
    expect(deriveChatGridIds({ ...input, sessionIds: ['todos:', 'todo:ACM-1'], chatless: true })).toEqual(['todos:', 'todo:ACM-1'])
  })

  it('still adds the "Open chat" picker beside them', async () => {
    const { deriveChatGridIds } = await import('../grid-placement')
    expect(deriveChatGridIds({ sessionIds: ['todos:'], primaryPaneKey: '__new__:0:', primarySessionId: null, chatless: true, pickerPaneKey: '__picker__' })).toEqual(['todos:', '__picker__'])
  })
})
