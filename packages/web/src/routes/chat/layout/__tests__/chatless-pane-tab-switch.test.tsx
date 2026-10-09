import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PaneTabIdContext, usePaneTabsStrip } from '@/components/chat/pane-tabs-context'
import { SplitChatGrid, SplitGridContext } from '../split-chat-grid'
import {
  appendSession,
  closeSession,
  createSplitLayout,
  focusGroupOfTab,
  groupOfSession,
  openDocTab,
  openNewChatTab,
  paneKeysFromLayout,
  pinTab,
  placeTab,
  showTab,
  splitGroup,
  type SplitLayout,
} from '../split-layout'
import { isNewChatTabId, todoTabId } from '../tab-kind'
import type { SplitLayoutControls } from '../use-split-working-set'

vi.mock('@/hooks/use-sessions', () => ({ useSessions: () => ({ data: [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Bravo' }] }) }))
vi.mock('@/lib/todo-preview', () => ({ useTodoPreview: () => ({ data: undefined }) }))
vi.mock('@/routes/todos/task-page/task-page', () => ({
  TaskView: ({ todoId }: { todoId: string }) => <div data-testid="todo-view">{todoId}</div>,
}))

/** A pane the page would render: here only its strip, found by its tab id as a new chat's title bar does. */
function PaneProbe({ paneKey }: { paneKey: string }) {
  return <div data-testid={`pane-body-${paneKey}`}>{usePaneTabsStrip(paneKey)}</div>
}

/** The grid with the layout held in state and real ops behind its controls, as the page wires them. */
function Grid({ start, latest }: { start: SplitLayout; latest: { current: SplitLayout } }) {
  const [layout, setLayout] = useState(start)
  latest.current = layout
  const apply = (op: (current: SplitLayout) => SplitLayout) => setLayout((current) => op(current))
  const split = {
    layout,
    resize: vi.fn(),
    equalize: vi.fn(),
    place: (groupId: string, id: string, index: number) => apply((current) => placeTab(current, groupId, id, index)),
    close: (id: string) => apply((current) => closeSession(current, id)),
    pin: (id: string) => apply((current) => pinTab(current, id)),
    show: (id: string) => apply((current) => showTab(current, id)),
    focusPane: (id: string) => apply((current) => focusGroupOfTab(current, id)),
  } as SplitLayoutControls
  const keys = paneKeysFromLayout(layout)
  return (
    <SplitGridContext.Provider value={{ split, sessionForKey: (key) => key }}>
      <SplitChatGrid
        sessionIds={keys}
        focusedId={keys[0]}
        width={1440}
        height={900}
        onFocus={vi.fn()}
        renderPane={(key) => <PaneTabIdContext.Provider value={key}><PaneProbe paneKey={key} /></PaneTabIdContext.Provider>}
      />
    </SplitGridContext.Provider>
  )
}

function tab(id: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>('[data-pane-tab-id]')].find((node) => node.dataset.paneTabId === id)!
}

describe('a tab chosen in the strip of a pane with no chat', () => {
  it('shows over a new chat that the pane was keyed by, instead of the new chat taking it back', () => {
    const start = openNewChatTab(appendSession(createSplitLayout(['a'], 'a'), 'b'))
    const fresh = groupOfSession(start, 'b')!.tabs.find(isNewChatTabId)!
    const latest = { current: start }
    render(<Grid start={start} latest={latest} />)

    fireEvent.click(tab('b'))

    expect(groupOfSession(latest.current, 'b')!.activeTab).toBe('b')
    expect(groupOfSession(latest.current, fresh)!.tabs).toEqual(['b', fresh])
  })

  it('switches between two documents in a document-only pane', async () => {
    const one = todoTabId('ACM-1')
    const two = todoTabId('ACM-2')
    let layout = openDocTab(appendSession(createSplitLayout(['a'], 'a'), 'b'), 'a', one)
    layout = splitGroup(layout, groupOfSession(layout, 'b')!.id, 'right', one)
    layout = openDocTab(layout, 'a', two)
    layout = placeTab(layout, groupOfSession(layout, one)!.id, two)
    expect(groupOfSession(layout, one)!.tabs).toEqual([one, two])
    const latest = { current: layout }
    render(<Grid start={layout} latest={latest} />)

    fireEvent.click(tab(one))

    expect(groupOfSession(latest.current, one)!.activeTab).toBe(one)
    // The Todo view is its own chunk, so it arrives a tick after the tab switches.
    expect((await screen.findByTestId('todo-view')).textContent).toBe('ACM-1')
  })
})
