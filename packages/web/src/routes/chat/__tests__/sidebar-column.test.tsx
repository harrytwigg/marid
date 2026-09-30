import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SidebarColumn } from '../sidebar-column'
import { DEFAULT_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } from '../sidebar-width'

const viewport = { width: 1600, height: 900 }

function column(open: boolean) {
  return render(<SidebarColumn open={open} viewport={viewport}><p>list</p></SidebarColumn>)
}

describe('SidebarColumn', () => {
  beforeEach(() => localStorage.clear())

  it('is the default width with a handle while open', () => {
    const { container } = column(true)
    expect((container.firstElementChild as HTMLElement).style.width).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`)
    expect(screen.getByRole('separator', { name: 'Resize chat list' })).toBeTruthy()
  })

  it('uses the saved width for the column and the list inside it', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360')
    const { container } = column(true)
    expect((container.firstElementChild as HTMLElement).style.width).toBe('360px')
    expect((screen.getByText('list').parentElement as HTMLElement).style.width).toBe('360px')
  })

  it('folds to zero width with no handle, keeping the list at its width', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360')
    const { container } = column(false)
    expect((container.firstElementChild as HTMLElement).style.width).toBe('0px')
    expect(screen.queryByRole('separator')).toBeNull()
    expect((screen.getByText('list').parentElement as HTMLElement).style.width).toBe('360px')
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy()
  })
})
