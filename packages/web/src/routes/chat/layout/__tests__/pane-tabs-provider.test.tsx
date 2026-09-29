import { useReducer } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PaneTabsContext, usePaneTabsKeep, usePaneTabsStrip } from '@/components/chat/pane-tabs-context'
import { PaneTabsProvider } from '../pane-tabs-provider'
import { closeSession, createSplitLayout, findGroup, focusSession, groupsOf, openInFocusedGroup, pinTab, placeTab, type SplitLayout } from '../split-layout'
import type { SplitLayoutControls } from '../use-split-working-set'

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({
    data: [
      { id: 'a', title: 'Alpha', employee: 'op', status: 'idle' },
      { id: 'x', title: 'Xray', employee: 'op', status: 'running' },
    ],
  }),
}))

/** A layout hook stand-in: real ops on a layout held in a variable, re-rendered on change. */
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
    close: (id) => set(closeSession(layout, id)),
    pin: (id) => { if (pinTab(layout, id) !== layout) set(pinTab(layout, id)) },
  } as SplitLayoutControls)
  return { onSelect, controls, set, get layout() { return layout }, bind: (fn: () => void) => { rerender = fn } }
}

function Probe({ sessionId, keepId }: { sessionId: string; keepId?: string }) {
  const strip = usePaneTabsStrip(sessionId)
  const keep = usePaneTabsKeep()
  return (
    <div>
      {strip}
      <button type="button" onClick={() => keepId && keep(keepId)}>work</button>
    </div>
  )
}

function Mount({ h, sessionId, keepId }: { h: ReturnType<typeof harness>; sessionId: string; keepId?: string }) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  h.bind(force)
  return (
    <PaneTabsProvider split={h.controls()} onSelect={h.onSelect}>
      <Probe sessionId={sessionId} keepId={keepId} />
    </PaneTabsProvider>
  )
}

const twoTabs = () => openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')

describe('PaneTabsProvider', () => {
  it('renders a strip only for a group with more than one tab', () => {
    const single = harness(createSplitLayout(['a'], 'a'))
    const { unmount } = render(<Mount h={single} sessionId="a" />)
    expect(screen.queryByTestId('pane-tab-strip')).toBeNull()
    unmount()

    const tabbed = harness(twoTabs())
    render(<Mount h={tabbed} sessionId="x" />)
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-pane-tab-id'))).toEqual(['a', 'x'])
    expect(screen.getByRole('tab', { name: /Xray/ }).getAttribute('data-preview')).toBe('true')
  })

  it('does not pin a preview tab just because its chat is running', () => {
    const h = harness(twoTabs())
    render(<Mount h={h} sessionId="x" />)
    expect(findGroup(h.layout, groupsOf(h.layout)[0].id)!.previewTab).toBe('x')
  })

  it('keeps the preview tab when the operator works in that chat', () => {
    const h = harness(twoTabs())
    render(<Mount h={h} sessionId="x" keepId="x" />)
    fireEvent.click(screen.getByText('work'))
    expect(groupsOf(h.layout)[0].previewTab).toBeUndefined()
  })

  it('keeps a chat that only joins the layout after the first send', () => {
    const h = harness(createSplitLayout(['a'], 'a'))
    render(<Mount h={h} sessionId="a" keepId="fresh" />)
    fireEvent.click(screen.getByText('work'))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a'])

    h.set(openInFocusedGroup(h.layout, 'fresh'))
    expect(groupsOf(h.layout)[0]).toMatchObject({ tabs: ['a', 'fresh'] })
    expect(groupsOf(h.layout)[0].previewTab).toBeUndefined()
  })

  it('leaves no keep request behind for a tab that was already kept', () => {
    const h = harness(pinTab(twoTabs(), 'x'))
    render(<Mount h={h} sessionId="x" keepId="x" />)
    fireEvent.click(screen.getByText('work'))
    h.set(closeSession(h.layout, 'x'))

    // Opened again later from the sidebar, it is an ordinary preview.
    h.set(openInFocusedGroup(h.layout, 'x'))
    expect(groupsOf(h.layout)[0].previewTab).toBe('x')
  })

  it('closing the shown tab moves the route to the tab that takes its place', () => {
    const h = harness(twoTabs())
    render(<Mount h={h} sessionId="x" />)
    fireEvent.click(screen.getByLabelText('Close tab Xray'))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a'])
    expect(h.onSelect).toHaveBeenCalledWith('a')
  })

  it('closing a tab the pane is not showing leaves the route alone', () => {
    const h = harness(focusSession(twoTabs(), 'a'))
    render(<Mount h={h} sessionId="a" />)
    fireEvent.click(screen.getByLabelText('Close tab Xray'))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a'])
    expect(h.onSelect).not.toHaveBeenCalled()
  })

  it('has no effect outside a provider', () => {
    render(
      <PaneTabsContext.Provider value={null}>
        <Probe sessionId="a" keepId="a" />
      </PaneTabsContext.Provider>,
    )
    fireEvent.click(screen.getByText('work'))
    expect(screen.queryByTestId('pane-tab-strip')).toBeNull()
  })
})
