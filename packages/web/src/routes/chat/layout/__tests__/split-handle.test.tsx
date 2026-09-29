import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KEYBOARD_STEP, SplitHandleBar } from '../split-handle'
import type { SplitHandle } from '../split-geometry'

const handle: SplitHandle = {
  splitId: 's1',
  index: 0,
  direction: 'row',
  rect: { left: 500, top: 0, width: 8, height: 600 },
  sizes: [0.5, 0.5],
  extent: 1000,
  minimums: [0.28, 0.28],
  childIds: ['g1', 'g2'],
}

function renderHandle(overrides: Partial<SplitHandle> = {}) {
  const callbacks = { onDrag: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn(), onReset: vi.fn() }
  render(<SplitHandleBar handle={{ ...handle, ...overrides }} {...callbacks} />)
  return { separator: screen.getByRole('separator'), ...callbacks }
}

describe('split handle', () => {
  it('is a focusable separator reporting the leading pane\'s share', () => {
    const { separator } = renderHandle({ sizes: [0.7, 0.3] })

    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.getAttribute('aria-valuenow')).toBe('70')
    expect(separator.tabIndex).toBe(0)
  })

  it('moves by a fixed step per arrow, four steps with Shift', () => {
    const { separator, onCommit } = renderHandle()

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true })

    expect(onCommit.mock.calls[0][0][0]).toBeCloseTo(0.5 + KEYBOARD_STEP / 1000)
    expect(onCommit.mock.calls[1][0][0]).toBeCloseTo(0.5 - (KEYBOARD_STEP * 4) / 1000)
  })

  it('stops at the neighbour\'s minimum', () => {
    const { separator, onCommit } = renderHandle()

    fireEvent.keyDown(separator, { key: 'End' })

    expect(onCommit.mock.calls[0][0][1]).toBeCloseTo(0.28)
  })

  it('ignores the other axis\' arrows', () => {
    const { separator, onCommit } = renderHandle()

    fireEvent.keyDown(separator, { key: 'ArrowDown' })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('drags live and commits once, on release', () => {
    const { separator, onDrag, onCommit } = renderHandle()

    fireEvent.pointerDown(separator, { pointerId: 1, button: 0, clientX: 504 })
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 604 })
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 604 })

    expect(onDrag).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0][0]).toBeCloseTo(0.6)
  })

  it('resets on double-click', () => {
    const { separator, onReset } = renderHandle()

    fireEvent.doubleClick(separator)

    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
