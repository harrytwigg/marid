import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureVisibleAnchor, restoreVisibleAnchor } from '../scroll-anchor'

/**
 * jsdom has no layout engine, so the list is given one: every row is ROW_H tall,
 * the scrollport is VIEWPORT_H tall, and a row's rect is derived from its
 * position in the CURRENT DOM order minus scrollTop. That makes "where is this
 * row on screen" a number the test can read before and after a reflow, which is
 * exactly what the anchor is supposed to hold.
 */

const ATTRIBUTE = 'data-anchor-id'
const ROW_H = 60
const VIEWPORT_H = 600

interface List {
  node: HTMLDivElement
  /** Replace the rendered rows, as a re-sort or a group move would. */
  setRows: (ids: string[]) => void
  /** Distance from the scrollport's top edge to this row's top edge. */
  offsetOf: (id: string) => number
  maxScrollTop: () => number
}

function mountList(ids: string[]): List {
  const node = document.createElement('div')
  document.body.append(node)

  const rowIds = () =>
    Array.from(node.querySelectorAll<HTMLElement>(`[${ATTRIBUTE}]`)).map((row) => row.getAttribute(ATTRIBUTE))
  const scrollHeight = () => rowIds().length * ROW_H
  const maxScrollTop = () => Math.max(0, scrollHeight() - VIEWPORT_H)
  let scrollTop = 0

  Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => VIEWPORT_H })
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => scrollHeight() })
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    // Browsers clamp; without this a restore could park the list past its end.
    set: (next: number) => { scrollTop = Math.max(0, Math.min(next, maxScrollTop())) },
  })

  const setRows = (next: string[]) => {
    node.replaceChildren(...next.map((id) => {
      const row = document.createElement('div')
      row.setAttribute(ATTRIBUTE, id)
      return row
    }))
  }
  setRows(ids)

  const offsetOf = (id: string) => rowIds().indexOf(id) * ROW_H - scrollTop
  const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON: () => ({}),
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === node) return rect(0, VIEWPORT_H) as DOMRect
    const id = this.getAttribute(ATTRIBUTE)
    if (!id || rowIds().indexOf(id) < 0) return rect(0, 0) as DOMRect
    return rect(offsetOf(id), ROW_H) as DOMRect
  })

  return { node, setRows, offsetOf, maxScrollTop }
}

function rows(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, k) => `TSK-${from + k}`)
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('captureVisibleAnchor', () => {
  it('anchors on the topmost row intersecting the scrollport, not the first row of the list', () => {
    const list = mountList(rows(1, 60))
    list.node.scrollTop = 1230

    const anchor = captureVisibleAnchor(list.node, ATTRIBUTE)

    expect(anchor.id).toBe('TSK-21')
    expect(anchor.offset).toBe(-30)
    expect(anchor.scrollTop).toBe(1230)
  })

  it('carries the attribute it measured with, so a restore cannot read a different one', () => {
    const list = mountList(rows(1, 60))

    expect(captureVisibleAnchor(list.node, ATTRIBUTE).attribute).toBe(ATTRIBUTE)
  })
})

describe('restoreVisibleAnchor', () => {
  it('holds the anchored row at its offset when rows are inserted above it', () => {
    const list = mountList(rows(1, 60))
    list.node.scrollTop = 1230
    const before = list.offsetOf('TSK-21')
    expect(before).toBe(-30)

    const anchor = captureVisibleAnchor(list.node, ATTRIBUTE)
    // A status change re-sorts three rows from below the reader into a group above.
    list.setRows([...rows(58, 3), ...rows(1, 57)])
    restoreVisibleAnchor(list.node, anchor)

    expect(list.offsetOf('TSK-21')).toBe(before)
    expect(list.node.scrollTop).toBe(1230 + 3 * ROW_H)
  })

  it('holds it when rows are removed above it', () => {
    const list = mountList(rows(1, 60))
    list.node.scrollTop = 1230
    const anchor = captureVisibleAnchor(list.node, ATTRIBUTE)

    list.setRows(rows(1, 60).filter((id) => id !== 'TSK-2' && id !== 'TSK-3'))
    restoreVisibleAnchor(list.node, anchor)

    expect(list.offsetOf('TSK-21')).toBe(-30)
    expect(list.node.scrollTop).toBe(1230 - 2 * ROW_H)
  })

  it('shifts by the content-height delta when the anchored row has left the DOM, without snapping to an edge', () => {
    const list = mountList(rows(1, 60))
    list.node.scrollTop = 1230
    const anchor = captureVisibleAnchor(list.node, ATTRIBUTE)
    expect(anchor.id).toBe('TSK-21')

    // The row moved into a collapsed group: it is gone, and the list is shorter.
    list.setRows(rows(1, 60).filter((id) => id !== 'TSK-21'))
    restoreVisibleAnchor(list.node, anchor)

    expect(list.node.scrollTop).toBe(1230 - ROW_H)
    expect(list.node.scrollTop).not.toBe(0)
    expect(list.node.scrollTop).not.toBe(list.maxScrollTop())
  })

  it('leaves the scroll position alone when nothing moved', () => {
    const list = mountList(rows(1, 60))
    list.node.scrollTop = 1230
    const anchor = captureVisibleAnchor(list.node, ATTRIBUTE)

    restoreVisibleAnchor(list.node, anchor)

    expect(list.node.scrollTop).toBe(1230)
  })
})
