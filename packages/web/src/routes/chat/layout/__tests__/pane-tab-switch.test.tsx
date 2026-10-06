import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { SplitChatGrid, SplitGridContext } from '../split-chat-grid'
import { tabSwitchedIn } from '../pane-tab-switch'
import { closeSession, createSplitLayout, focusSession, openInFocusedGroup, pinTab, splitGroup, type SplitLayout } from '../split-layout'
import type { SplitLayoutControls } from '../use-split-working-set'

vi.mock('@/hooks/use-sessions', () => ({ useSessions: () => ({ data: [] }) }))

/** Three kept tabs in one group, `a` showing. */
function threeTabs(): SplitLayout {
  let layout = createSplitLayout(['a'], 'a')
  for (const id of ['b', 'c']) layout = pinTab(openInFocusedGroup(layout, id), id)
  return focusSession(layout, 'a')
}

describe('tabSwitchedIn', () => {
  it('names the chat a group switched to when the group already held it', () => {
    const before = threeTabs()
    expect([...tabSwitchedIn(before, focusSession(before, 'c'))]).toEqual(['c'])
  })

  it('counts closing the tab in front as a switch to the tab that takes its place', () => {
    const before = focusSession(threeTabs(), 'b')
    const after = closeSession(before, 'b')
    const shown = [...tabSwitchedIn(before, after)]
    expect(shown).toHaveLength(1)
    expect(['a', 'c']).toContain(shown[0])
  })

  it('is empty for the first layout and for one that changed nothing', () => {
    const layout = threeTabs()
    expect(tabSwitchedIn(null, layout).size).toBe(0)
    expect(tabSwitchedIn(layout, layout).size).toBe(0)
  })

  it('leaves a chat opened into a group as an arrival, so an open keeps its motion', () => {
    const before = threeTabs()
    const after = openInFocusedGroup(before, 'd')
    expect(after).not.toBe(before)
    expect(tabSwitchedIn(before, after).size).toBe(0)
  })

  it('leaves a chat that arrives in a new pane as an arrival', () => {
    const before = threeTabs()
    const after = splitGroup(before, before.focusedGroupId!, 'right', 'b')
    expect(tabSwitchedIn(before, after).size).toBe(0)
  })

  it('reads each group on its own: switching in one leaves the other pane alone', () => {
    let layout = createSplitLayout(['a'], 'a')
    layout = pinTab(openInFocusedGroup(layout, 'b'), 'b')
    layout = splitGroup(layout, layout.focusedGroupId!, 'right', 'x')
    layout = pinTab(openInFocusedGroup(layout, 'y'), 'y')
    layout = focusSession(layout, 'x')
    layout = focusSession(layout, 'a')
    expect([...tabSwitchedIn(layout, focusSession(layout, 'b'))]).toEqual(['b'])
    expect([...tabSwitchedIn(layout, focusSession(layout, 'y'))]).toEqual(['y'])
  })
})

type GridProps = ComponentProps<typeof SplitChatGrid>

/** The grid the page mounts, driven by a layout the test owns and re-renders. */
function Grid({ layout, sessionIds }: { layout: SplitLayout; sessionIds: string[] }) {
  const split = { layout, resize: vi.fn(), equalize: vi.fn(), place: vi.fn(), close: vi.fn(), pin: vi.fn(), show: vi.fn(), focusPane: vi.fn() } as SplitLayoutControls
  const props: GridProps = {
    sessionIds,
    focusedId: sessionIds[0],
    width: 1440,
    height: 900,
    onFocus: vi.fn(),
    renderPane: (id) => <div data-chat-pane-session={id} />,
  }
  return (
    <SplitGridContext.Provider value={{ split, sessionForKey: (key) => key }}>
      <SplitChatGrid {...props} />
    </SplitGridContext.Provider>
  )
}

const frame = (id: string) => document.querySelector<HTMLElement>(`[data-chat-grid-pane="${id}"]`)

describe('a pane brought forward by a tab switch', () => {
  it('is marked, so the open animation stays off it for as long as it shows', () => {
    const before = threeTabs()
    const { rerender } = render(<Grid layout={before} sessionIds={['a']} />)
    expect(frame('a')?.dataset.paneArrival).toBeUndefined()

    const switched = focusSession(before, 'c')
    rerender(<Grid layout={switched} sessionIds={['c']} />)
    expect(frame('c')?.dataset.paneArrival).toBe('tab-switch')

    // A later layout change while the pane is still showing must not clear the mark: with it
    // gone the pane's own open animation would start on a chat that is already showing.
    rerender(<Grid layout={openInFocusedGroup(switched, 'd')} sessionIds={['c']} />)
    expect(frame('c')?.dataset.paneArrival).toBe('tab-switch')
  })

  it('is not marked when the chat is opened rather than switched to', () => {
    const before = threeTabs()
    const { rerender } = render(<Grid layout={before} sessionIds={['a']} />)
    rerender(<Grid layout={openInFocusedGroup(before, 'd')} sessionIds={['d']} />)
    expect(frame('d')?.dataset.paneArrival).toBeUndefined()
  })
})
