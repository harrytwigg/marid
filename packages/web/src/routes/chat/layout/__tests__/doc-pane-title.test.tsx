import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PaneTabsContext, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'
import { DocPaneTitle } from '../doc-pane'

const DOC = { kind: 'todo', todoId: 'SAN-1' } as const
const DRAG = { draggable: true as const, onDragStart: () => {}, onDragEnd: () => {} }

/** The binding the layout gives a pane's bar; `closeAll` is absent when nothing is open. */
function binding(closeAll?: () => void): PaneTabsBinding {
  return { renderStrip: () => null, hasStrips: false, keep: () => {}, shownDoc: () => null, closable: () => true, closeAll }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

/** The document's own title bar needs the query client a real pane has (its kind label may read). */
function bar(active: boolean, closeAll?: () => void): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <PaneTabsContext.Provider value={binding(closeAll)}>
        <DocPaneTitle doc={DOC} active={active} drag={DRAG} onClose={vi.fn()} />
      </PaneTabsContext.Provider>
    </QueryClientProvider>
  )
}

describe('DocPaneTitle close-all', () => {
  it('carries it in the focused pane, and runs', () => {
    const closeAll = vi.fn()
    render(bar(true, closeAll))

    fireEvent.click(screen.getByRole('button', { name: 'Close all tabs' }))
    expect(closeAll).toHaveBeenCalledTimes(1)
  })

  it('leaves it to the focused bar', () => {
    render(bar(false, vi.fn()))
    expect(screen.queryByRole('button', { name: 'Close all tabs' })).toBeNull()
  })

  it('does not offer it when nothing is open', () => {
    render(bar(true))
    expect(screen.queryByRole('button', { name: 'Close all tabs' })).toBeNull()
  })
})
