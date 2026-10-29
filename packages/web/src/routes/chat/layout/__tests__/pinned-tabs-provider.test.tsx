import "@/test/preload-menus"
import { useReducer } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePaneTabsDocPane, usePaneTabsStrip } from '@/components/chat/pane-tabs-context'
import { PaneTabsProvider } from '../pane-tabs-provider'
import { fileTabId } from '../file-tab'
import { closeAllUnpinned, closeUserTab, pinTab, unpinTab } from '../pinned-tabs'
import { createSplitLayout, groupOfSession, groupsOf, keepTab, materializeLayout, openDocTab, openInFocusedGroup, placeTab, showTab, splitGroup, type SplitLayout } from '../split-layout'
import { TODOS_TAB_ID } from '../tab-kind'
import type { SplitLayoutControls } from '../use-split-working-set'

vi.mock('@/components/chat/file-view', () => ({ FileView: ({ path }: { path: string }) => <div data-testid="file-view">{path}</div> }))
vi.mock('@/lib/todo-preview', () => ({ useTodoPreview: () => ({ data: { workItem: { title: 'Write the notes' } } }) }))
vi.mock('@/routes/todos/task-page/task-page', () => ({ TaskView: () => <div /> }))
vi.mock('@/hooks/use-employees', () => ({
  useOrg: () => ({ data: { employees: [{ name: 'op', displayName: 'Operator' }, { name: 'lead', displayName: 'Team Lead' }] } }),
}))
vi.mock('@/hooks/use-sessions', () => ({
  useUpdateSession: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
  useSessions: () => ({
    data: [
      { id: 'a', title: 'Alpha', employee: 'op', status: 'idle' },
      { id: 'x', title: '', employee: 'lead', status: 'idle' },
      { id: 'z', title: 'Zulu', employee: 'unknown-employee', status: 'idle' },
    ],
  }),
}))

const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
const notes = fileTabId({ path: 'docs/notes.md', sessionId: 'a' })

/** A layout hook stand-in: the real ops on a layout held in a variable, re-rendered on change. */
function harness(start: SplitLayout) {
  let layout = start
  let rerender: () => void = () => undefined
  const set = (next: SplitLayout) => { layout = next; act(() => rerender()) }
  const onSelect = vi.fn()
  const controls = (): SplitLayoutControls => ({
    layout,
    resize: vi.fn(),
    equalize: vi.fn(),
    place: (groupId, id, index) => set(placeTab(layout, groupId, id, index)),
    close: (id) => set(closeUserTab(layout, id)),
    closeAll: () => set(closeAllUnpinned(layout)),
    keep: (id) => set(keepTab(layout, id)),
    pin: (id) => set(pinTab(layout, id)),
    unpin: (id) => set(unpinTab(layout, id)),
    show: (id) => set(showTab(layout, id)),
    focusPane: vi.fn(),
  })
  return { onSelect, controls, bind: (fn: () => void) => { rerender = fn }, get layout() { return layout } }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Strip({ sessionId }: { sessionId: string }) {
  return <div>{usePaneTabsStrip(sessionId)}</div>
}

function DocPane({ paneKey }: { paneKey: string }) {
  return <div>{usePaneTabsDocPane()(paneKey)}</div>
}

function Mount({ h, children }: { h: ReturnType<typeof harness>; children: React.ReactNode }) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  h.bind(force)
  return (
    <QueryClientProvider client={queryClient}>
      <PaneTabsProvider split={h.controls()} onSelect={h.onSelect}>{children}</PaneTabsProvider>
    </QueryClientProvider>
  )
}

const tabIds = () => screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-pane-tab-id'))

/** `a` with the Todos tab and two files beside it. */
function crowded(): SplitLayout {
  return openDocTab(openDocTab(openDocTab(createSplitLayout(['a'], 'a'), 'a', notes), 'a', report), 'a', TODOS_TAB_ID)
}

describe('PaneTabsProvider and pinned tabs', () => {
  it('draws the pinned tabs first and compact, with no close button, and pins and unpins from the strip', () => {
    const h = harness(crowded())
    render(<Mount h={h}><Strip sessionId="a" /></Mount>)
    expect(tabIds()).toEqual(['a', TODOS_TAB_ID, report, notes])

    fireEvent.click(screen.getByRole('button', { name: `Pin tab ${'report.md'}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin tab Todos' }))
    expect(tabIds()).toEqual([report, TODOS_TAB_ID, 'a', notes])
    expect(h.layout.pinned).toEqual([report, TODOS_TAB_ID])
    const pinned = screen.getAllByRole('tab').slice(0, 2)
    expect(pinned.map((tab) => tab.getAttribute('data-pinned'))).toEqual(['true', 'true'])
    expect(pinned.every((tab) => tab.querySelector('[aria-label^="Close tab"]') === null)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Unpin tab Todos' }))
    expect(tabIds()).toEqual([report, TODOS_TAB_ID, 'a', notes])
    expect(h.layout.pinned).toEqual([report])
  })

  it('closes nothing for a pinned tab, by Delete or a middle-click, and an unpinned one still closes', () => {
    const h = harness(pinTab(crowded(), report))
    render(<Mount h={h}><Strip sessionId="a" /></Mount>)
    const tab = (id: string) => screen.getAllByRole('tab').find((node) => node.getAttribute('data-pane-tab-id') === id)!
    fireEvent.keyDown(tab(report), { key: 'Delete' })
    fireEvent.mouseDown(tab(report), { button: 1 })
    expect(tabIds()).toContain(report)
    fireEvent.keyDown(tab(notes), { key: 'Delete' })
    expect(tabIds()).not.toContain(notes)
  })

  it('titles a chat without a title by its employee, and says both in the tooltip', () => {
    const h = harness(openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x'))
    render(<Mount h={h}><Strip sessionId="a" /></Mount>)
    const tab = screen.getByRole('tab', { name: /Team Lead/ })
    expect(within(tab).queryByText('Chat')).toBeNull()
    expect(tab.getAttribute('title')).toBe('Team Lead')
    expect(screen.getByRole('tab', { name: /Alpha/ }).getAttribute('title')).toBe('Alpha — Operator')
  })

  it('falls back to the employee handle when the roster lacks it, and to "Chat" when nothing is known', () => {
    const h = harness(openInFocusedGroup(keepTab(openInFocusedGroup(createSplitLayout(['a'], 'a'), 'z'), 'z'), 'nobody'))
    render(<Mount h={h}><Strip sessionId="a" /></Mount>)
    expect(screen.getByRole('tab', { name: /Zulu/ }).getAttribute('title')).toBe('Zulu — unknown-employee')
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeTruthy()
  })

  describe('a lone document pane', () => {
    function splitOut(): SplitLayout {
      const arranged = openDocTab(materializeLayout(createSplitLayout(['a', 'x'], 'a'), 2), 'a', report)
      return splitGroup(arranged, groupOfSession(arranged, 'a')!.id, 'right', report)
    }

    it('offers the tab menu on its title bar, so a lone tab can be pinned', async () => {
      const h = harness(splitOut())
      render(<Mount h={h}><DocPane paneKey={report} /></Mount>)
      fireEvent.contextMenu(await screen.findByTestId('doc-pane-title'), { clientX: 5, clientY: 5 })
      expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab', 'Close tab'])
      fireEvent.click(screen.getByRole('menuitem', { name: 'Pin tab' }))
      expect(h.layout.pinned).toEqual([report])
      expect(groupsOf(h.layout)).toHaveLength(3)
    })

    it('swaps its close button for an unpin glyph once pinned, and its menu for Unpin tab alone', async () => {
      const h = harness(pinTab(splitOut(), report))
      render(<Mount h={h}><DocPane paneKey={report} /></Mount>)
      const title = await screen.findByTestId('doc-pane-title')
      expect(within(title).queryByRole('button', { name: /^Close/ })).toBeNull()
      fireEvent.contextMenu(title, { clientX: 5, clientY: 5 })
      expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Unpin tab'])
      fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin tab' }))
      expect(h.layout.pinned).toEqual([])
    })

    it('does not close a pinned lone pane from its title bar', async () => {
      const h = harness(pinTab(splitOut(), report))
      render(<Mount h={h}><DocPane paneKey={report} /></Mount>)
      expect(within(await screen.findByTestId('doc-pane-title')).queryByRole('button', { name: /Close/ })).toBeNull()
      expect(h.onSelect).not.toHaveBeenCalled()
    })
  })
})
