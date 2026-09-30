import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moveHandle } from '../layout/split-layout'
import { SidebarResizeHandle } from '../sidebar-resize-handle'
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  loadSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sidebarHandle,
  sidebarWidthBounds,
  widthFromSizes,
} from '../sidebar-width'
import { useSidebarWidth } from '../use-sidebar-width'

describe('sidebar width bounds', () => {
  it('holds the configured range in a wide window', () => {
    expect(sidebarWidthBounds(1600)).toEqual({ min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH })
  })

  it('shrinks the maximum to leave the thread its floor, never below the minimum', () => {
    expect(sidebarWidthBounds(1024).max).toBe(MAX_SIDEBAR_WIDTH)
    expect(sidebarWidthBounds(900).max).toBe(900 - 56 - 420)
    expect(sidebarWidthBounds(600)).toEqual({ min: MIN_SIDEBAR_WIDTH, max: MIN_SIDEBAR_WIDTH })
  })

  it('clamps a width into the range and falls back to the default for garbage', () => {
    expect(clampSidebarWidth(50, 1600)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(9000, 1600)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(301.6, 1600)).toBe(302)
    expect(clampSidebarWidth(Number.NaN, 1600)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})

describe('sidebar handle model', () => {
  it('drags through moveHandle and clamps at both ends', () => {
    const viewport = 1600
    const handle = sidebarHandle(300, viewport, 900)
    const dragBy = (pixels: number) => widthFromSizes(moveHandle(handle.sizes, 0, pixels / handle.extent, handle.minimums), viewport)

    expect(dragBy(40)).toBeCloseTo(340)
    expect(dragBy(-1000)).toBe(MIN_SIDEBAR_WIDTH)
    expect(dragBy(5000)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('places the handle on the list\'s right edge', () => {
    expect(sidebarHandle(320, 1600, 900).rect).toEqual({ left: 320, top: 0, width: 0, height: 900 })
  })
})

describe('stored width', () => {
  beforeEach(() => localStorage.clear())

  it('ignores missing and implausible values', () => {
    expect(loadSidebarWidth()).toBeNull()
    for (const junk of ['abc', '-5', '0', '']) {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, junk)
      expect(loadSidebarWidth()).toBeNull()
    }
  })

  it('starts from the saved width, persists a commit, and forgets it on reset', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360')
    const { result } = renderHook(() => useSidebarWidth(1600))
    expect(result.current.width).toBe(360)

    act(() => result.current.drag(400))
    expect(result.current.width).toBe(400)
    expect(result.current.dragging).toBe(true)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('360')

    act(() => result.current.commit(410))
    expect(result.current.dragging).toBe(false)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('410')

    act(() => result.current.reset())
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull()
  })

  it('cancel drops the preview without saving', () => {
    const { result } = renderHook(() => useSidebarWidth(1600))
    act(() => result.current.drag(450))
    act(() => result.current.cancel())
    expect(result.current.width).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull()
  })

  it('shows a saved width clamped to a narrow window without rewriting it', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '480')
    const { result, rerender } = renderHook(({ width }) => useSidebarWidth(width), { initialProps: { width: 900 } })
    expect(result.current.width).toBe(900 - 56 - 420)
    rerender({ width: 1600 })
    expect(result.current.width).toBe(480)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('480')
  })
})

describe('SidebarResizeHandle', () => {
  it('is a labelled separator that commits keyboard steps and resets on double-click', () => {
    const callbacks = { onDrag: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn(), onReset: vi.fn() }
    render(<SidebarResizeHandle width={280} viewport={{ width: 1600, height: 900 }} {...callbacks} />)
    const separator = screen.getByRole('separator', { name: 'Resize chat list' })

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(callbacks.onCommit).toHaveBeenCalledWith(expect.closeTo(296, 3))
    fireEvent.keyDown(separator, { key: 'End' })
    expect(callbacks.onCommit).toHaveBeenLastCalledWith(expect.closeTo(MAX_SIDEBAR_WIDTH, 3))
    fireEvent.doubleClick(separator)
    expect(callbacks.onReset).toHaveBeenCalledOnce()
  })
})
