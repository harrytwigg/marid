import "@/test/preload-menus"
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PaneTabsContext, type PaneTabActions, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'
import { ChatPaneTitleBar } from '../chat-pane-title-bar'

function actions(overrides: Partial<PaneTabActions> = {}): PaneTabActions {
  return { pinned: false, canClose: true, pin: vi.fn(), unpin: vi.fn(), close: vi.fn(), ...overrides }
}

function binding(tabActions?: PaneTabActions | null): PaneTabsBinding {
  return { renderStrip: () => null, hasStrips: false, keep: () => {}, shownDoc: () => null, closable: () => true, tabActions: () => tabActions ?? null }
}

function bar(tabActions?: PaneTabActions | null) {
  return (
    <PaneTabsContext.Provider value={binding(tabActions)}>
      <ChatPaneTitleBar active title="Release planning" employee="op" session={{ id: 'a', status: 'idle' }} onClose={vi.fn()} />
    </PaneTabsContext.Provider>
  )
}

describe('a lone chat\'s title bar and its tab menu', () => {
  it('offers Pin tab and Close tab on right-click, and runs them', async () => {
    const tab = actions()
    render(bar(tab))
    fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'), { clientX: 12, clientY: 12 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab', 'Close tab'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin tab' }))
    expect(tab.pin).toHaveBeenCalledTimes(1)
  })

  it('shows an unpin glyph and Unpin tab alone once pinned', async () => {
    const tab = actions({ pinned: true, canClose: false })
    render(bar(tab))
    fireEvent.click(screen.getByRole('button', { name: 'Unpin tab Release planning' }))
    expect(tab.unpin).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'), { clientX: 12, clientY: 12 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Unpin tab'])
  })

  it('leaves the browser\'s own menu alone with no tab to act on', () => {
    render(bar(null))
    expect(fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'))).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the bar and what is in it mounted when the tab gains or loses its menu', async () => {
    const { rerender } = render(bar(null))
    const actionsNode = screen.getByTestId('chat-pane-title-actions')
    const barNode = screen.getByTestId('chat-pane-title-bar')
    rerender(bar(actions()))
    expect(screen.getByTestId('chat-pane-title-bar')).toBe(barNode)
    expect(screen.getByTestId('chat-pane-title-actions')).toBe(actionsNode)
    fireEvent.contextMenu(barNode, { clientX: 5, clientY: 5 })
    await screen.findByRole('menu')
    rerender(bar(null))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByTestId('chat-pane-title-bar')).toBe(barNode)
    expect(screen.getByTestId('chat-pane-title-actions')).toBe(actionsNode)
  })
})
