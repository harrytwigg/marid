import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MobileSessionTabs } from '../mobile-session-tabs'

const tabs = [
  { id: 'a', title: 'Alpha', moved: false },
  { id: 'b', title: 'Beta', moved: true },
  { id: 'c', title: 'A very long conversation title that must truncate rather than push the strip wider', moved: false },
]

describe('MobileSessionTabs', () => {
  it('labels every tab and marks only the active one selected', () => {
    render(<MobileSessionTabs tabs={tabs} activeId="a" onSelect={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('navigation', { name: 'Open chats' })).toBeTruthy()
    const all = screen.getAllByRole('tab')
    expect(all.map((tab) => tab.textContent)).toEqual(tabs.map((tab) => tab.title))
    expect(all.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
  })

  it('switches on tap', () => {
    const onSelect = vi.fn()
    render(<MobileSessionTabs tabs={tabs} activeId="a" onSelect={onSelect} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('offers close on the active tab only, and closes that tab', () => {
    const onClose = vi.fn()
    render(<MobileSessionTabs tabs={tabs} activeId="b" onSelect={vi.fn()} onClose={onClose} />)

    expect(screen.getAllByRole('button', { name: /^Close / })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close Beta' }))
    expect(onClose).toHaveBeenCalledWith('b')
  })

  it('shows the updated dot on a background tab, not the active one', () => {
    const { container, rerender } = render(<MobileSessionTabs tabs={tabs} activeId="a" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('[data-mobile-session-tab-cell="b"] [data-mobile-session-tab-moved]')).not.toBeNull()

    rerender(<MobileSessionTabs tabs={tabs} activeId="b" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('[data-mobile-session-tab-moved]')).toBeNull()
  })

  it('brings the active tab back into view when titles arrive and widen the tabs', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const placeholder = tabs.map((tab) => ({ ...tab, title: 'Chat' }))
      const { rerender } = render(<MobileSessionTabs tabs={placeholder} activeId="c" onSelect={vi.fn()} onClose={vi.fn()} />)
      scrollIntoView.mockClear()
      rerender(<MobileSessionTabs tabs={tabs} activeId="c" onSelect={vi.fn()} onClose={vi.fn()} />)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-mobile-session-tab-cell="c"]'))
    } finally {
      // @ts-expect-error jsdom does not implement it; restore that
      delete Element.prototype.scrollIntoView
    }
  })

  it('brings the active tab into view when the focus moves', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const { rerender } = render(<MobileSessionTabs tabs={tabs} activeId="a" onSelect={vi.fn()} onClose={vi.fn()} />)
      scrollIntoView.mockClear()
      rerender(<MobileSessionTabs tabs={tabs} activeId="c" onSelect={vi.fn()} onClose={vi.fn()} />)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-mobile-session-tab-cell="c"]'))
    } finally {
      // @ts-expect-error jsdom does not implement it; restore that
      delete Element.prototype.scrollIntoView
    }
  })
})
