import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarColumn } from '../sidebar-column'
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } from '../sidebar-width'

const viewport = { width: 1600, height: 900 }

function column(open: boolean, onOpenChange = vi.fn()) {
  const view = render(
    <SidebarColumn open={open} viewport={viewport} onOpenChange={onOpenChange}><p>list</p></SidebarColumn>,
  )
  return { ...view, onOpenChange }
}

const columnWidth = (container: HTMLElement) => (container.firstElementChild as HTMLElement).style.width
const listWidth = () => (screen.getByText('list').parentElement as HTMLElement).style.width

describe('SidebarColumn', () => {
  beforeEach(() => localStorage.clear())

  it('is the default width with a handle while open', () => {
    const { container } = column(true)
    expect(columnWidth(container)).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`)
    expect(screen.getByRole('separator', { name: 'Resize chat list' })).toBeTruthy()
  })

  it('uses the saved width for the column and the list inside it', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360')
    const { container } = column(true)
    expect(columnWidth(container)).toBe('360px')
    expect(listWidth()).toBe('360px')
  })

  it('folds to zero width, keeping the list at its width and its handle on the edge', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360')
    const { container } = column(false)
    expect(columnWidth(container)).toBe('0px')
    // The handle survives the fold, on the ribbon's edge, so dragging can reopen the list.
    expect(screen.getByRole('separator', { name: 'Resize chat list' })).toBeTruthy()
    expect(listWidth()).toBe('360px')
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })

  it('collapses when dragged past the threshold, without saving the snap-zone width', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '300')
    const { container, onOpenChange } = column(true)
    const handle = screen.getByRole('separator', { name: 'Resize chat list' })

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 })
    expect(columnWidth(container)).toBe('0px') // snapped shut while the pointer is still down

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('300')
  })

  it('reopens dragged out from the collapsed edge and persists the new width', () => {
    const { container, onOpenChange } = column(false)
    const handle = screen.getByRole('separator', { name: 'Resize chat list' })

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 })
    expect(columnWidth(container)).toBe('300px') // opens with the drag

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300 })
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('300')
  })

  it('reopens on a keyboard step while collapsed, since the edge has nowhere further to go', () => {
    const { onOpenChange } = column(false)
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize chat list' }), { key: 'ArrowRight' })
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('stops a keyboard step at the open minimum instead of folding the list', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '300')
    const { container, onOpenChange } = column(true)
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize chat list' }), { key: 'Home' })
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(columnWidth(container)).toBe(`${MIN_SIDEBAR_WIDTH}px`)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(MIN_SIDEBAR_WIDTH))
  })

  it('clamps a Shift+ArrowLeft at the minimum rather than folding the list', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(MIN_SIDEBAR_WIDTH))
    const { container, onOpenChange } = column(true)
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize chat list' }), { key: 'ArrowLeft', shiftKey: true })
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(columnWidth(container)).toBe(`${MIN_SIDEBAR_WIDTH}px`)
  })
})
