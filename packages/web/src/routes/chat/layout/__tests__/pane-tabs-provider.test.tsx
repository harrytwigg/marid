import { useReducer } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PaneTabsContext, usePaneTabsFilePane, usePaneTabsKeep, usePaneTabsStrip } from '@/components/chat/pane-tabs-context'
import { PaneTabsProvider } from '../pane-tabs-provider'
import { closeSession, createSplitLayout, findGroup, focusSession, groupOfSession, groupsOf, materializeLayout, openFileTab, openInFocusedGroup, pinTab, placeTab, showTab, splitGroup, type SplitLayout } from '../split-layout'
import { fileTabId } from '../file-tab'
import { CHAT_SESSION_DND_MIME } from '../../chat-session-dnd'
import { PANE_TAB_DND_MIME } from '../pane-tab-dnd'

/** A drop on the strip as the browser delivers it: jsdom has no DragEvent, so build one. */
function dropOn(target: Element, data: Record<string, string>) {
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? '', dropEffect: 'none' }
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.assign(event, { dataTransfer, clientX: 10_000 })
  act(() => { target.dispatchEvent(event) })
}
import { usePaneShownFile } from '@/components/chat/pane-tabs-context'
import type { SplitLayoutControls } from '../use-split-working-set'

vi.mock('@/components/chat/file-view', () => ({
  FileView: ({ path }: { path: string }) => <div data-testid="file-view">{path}</div>,
}))

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
    show: (id) => { if (showTab(layout, id) !== layout) set(showTab(layout, id)) },
  } as SplitLayoutControls)
  return { onSelect, controls, set, get layout() { return layout }, bind: (fn: () => void) => { rerender = fn } }
}

function Probe({ sessionId, keepId }: { sessionId: string; keepId?: string }) {
  const strip = usePaneTabsStrip(sessionId)
  const keep = usePaneTabsKeep()
  const file = usePaneShownFile(sessionId)
  return (
    <div>
      {strip}
      {file ? <output data-testid="shown-file">{file.path}</output> : null}
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

  it('shows a file tab beside its chat, the chat staying the route', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    // Opened from chat a, which is shown beside the file even though x was the shown tab.
    const h = harness(openFileTab(twoTabs(), 'a', report))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a', report, 'x'])
    render(<Mount h={h} sessionId="a" />)

    const fileTab = screen.getByRole('tab', { name: /report\.md/ })
    expect(fileTab.getAttribute('data-pane-tab-kind')).toBe('file')
    expect(fileTab.getAttribute('title')).toBe('docs/report.md')
    expect(fileTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('shown-file').textContent).toBe('docs/report.md')

    // Back to the chat: shown in the group, not merely focused (which would keep the file).
    fireEvent.click(screen.getByRole('tab', { name: /Alpha/ }))
    expect(findGroup(h.layout, groupsOf(h.layout)[0].id)!.activeTab).toBe('a')
    expect(h.onSelect).toHaveBeenLastCalledWith('a')
    expect(screen.queryByTestId('shown-file')).toBeNull()

    // And to the file again: the route stays on the chat it sits beside.
    fireEvent.click(screen.getByRole('tab', { name: /report\.md/ }))
    expect(screen.getByTestId('shown-file').textContent).toBe('docs/report.md')
    expect(h.onSelect).toHaveBeenLastCalledWith('a')

    fireEvent.click(screen.getByLabelText('Close tab report.md'))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a', 'x'])
    expect(h.onSelect).toHaveBeenLastCalledWith('a')
  })

  it('closing the chat a file is shown over moves the route to the chat left in the pane', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'x' })
    const h = harness(openFileTab(twoTabs(), 'x', report))
    render(<Mount h={h} sessionId="x" />)
    fireEvent.click(screen.getByLabelText('Close tab Xray'))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a', report])
    expect(h.onSelect).toHaveBeenLastCalledWith('a')
  })

  it('a sidebar chat dropped into the strip is shown and becomes the route', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    const h = harness(openFileTab(createSplitLayout(['a'], 'a'), 'a', report))
    render(<Mount h={h} sessionId="a" />)
    dropOn(screen.getByTestId('pane-tab-strip'), { [CHAT_SESSION_DND_MIME]: 'x' })
    expect(groupsOf(h.layout)[0]).toMatchObject({ tabs: ['a', report, 'x'], activeTab: 'x' })
    expect(h.onSelect).toHaveBeenLastCalledWith('x')
  })

  it('a file tab dragged into another pane routes to that pane\'s chat', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    const start = focusSession(openFileTab(createSplitLayout(['a', 'x'], 'a'), 'a', report), 'x')
    const h = harness(placeTab(start, groupsOf(start)[1].id, 'b'))
    const [source, target] = groupsOf(h.layout)
    render(<Mount h={h} sessionId="b" />)
    dropOn(screen.getByTestId('pane-tab-strip'), { [PANE_TAB_DND_MIME]: JSON.stringify({ groupId: source.id, tabId: report }) })
    expect(findGroup(h.layout, target.id)).toMatchObject({ activeTab: report })
    expect(h.onSelect).toHaveBeenLastCalledWith('b')
  })

  describe('a file-only pane', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })

    /** a | x arranged, the report split out between them. */
    function splitOut() {
      const arranged = openFileTab(materializeLayout(createSplitLayout(['a', 'x'], 'a'), 2), 'a', report)
      return splitGroup(arranged, groupOfSession(arranged, 'a')!.id, 'right', report)
    }

    function FilePaneProbe({ paneKey }: { paneKey: string }) {
      return <div>{usePaneTabsFilePane()(paneKey)}</div>
    }

    function MountFile({ h, paneKey }: { h: ReturnType<typeof harness>; paneKey: string }) {
      const [, force] = useReducer((n: number) => n + 1, 0)
      h.bind(force)
      return (
        <PaneTabsProvider split={h.controls()} onSelect={h.onSelect}>
          <FilePaneProbe paneKey={paneKey} />
        </PaneTabsProvider>
      )
    }

    it('renders the file under a strip of its own, even for a lone file tab', async () => {
      const h = harness(splitOut())
      render(<MountFile h={h} paneKey={report} />)
      expect((await screen.findByTestId('file-view')).textContent).toBe('docs/report.md')
      const strip = screen.getByTestId('pane-tab-strip')
      expect(strip.querySelectorAll('[role="tab"]')).toHaveLength(1)
      expect(strip.querySelector('[data-pane-tab-kind="file"]')).not.toBeNull()
    })

    it('renders nothing for a pane key that is no file-only pane', () => {
      const h = harness(splitOut())
      render(<MountFile h={h} paneKey="a" />)
      expect(screen.queryByTestId('file-pane')).toBeNull()
    })

    it('closing its tab closes the pane and leaves the route where it was', () => {
      const h = harness(splitOut())
      render(<MountFile h={h} paneKey={report} />)
      fireEvent.click(screen.getByLabelText('Close tab report.md'))
      expect(groupOfSession(h.layout, report)).toBeNull()
      expect(h.onSelect).not.toHaveBeenCalledWith(report)
    })

    it('dragged into a chat\'s strip, goes back to that chat and the route follows it', () => {
      const h = harness(placeTab(splitOut(), groupOfSession(splitOut(), 'x')!.id, 'b'))
      const fileGroup = groupOfSession(h.layout, report)!
      render(<Mount h={h} sessionId="b" />)
      dropOn(screen.getByTestId('pane-tab-strip'), { [PANE_TAB_DND_MIME]: JSON.stringify({ groupId: fileGroup.id, tabId: report }) })
      expect(groupOfSession(h.layout, report)!.tabs).toContain('b')
      expect(h.onSelect).toHaveBeenLastCalledWith('b')
    })
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
