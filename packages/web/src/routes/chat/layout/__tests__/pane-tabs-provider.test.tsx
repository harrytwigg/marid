import { useReducer } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PaneTabsContext, usePaneTabsDocPane, usePaneTabsKeep, usePaneTabsStrip, usePaneTitleDrag } from '@/components/chat/pane-tabs-context'
import { PaneTabsProvider } from '../pane-tabs-provider'
import { closeSession, createSplitLayout, findGroup, focusSession, groupOfSession, groupsOf, materializeLayout, openDocTab, openInFocusedGroup, openNewChatTab, pinTab, placeTab, showTab, splitGroup, type SplitLayout } from '../split-layout'
import { isNewChatTabId, todoTabId } from '../tab-kind'
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
import { usePaneShownDoc } from '@/components/chat/pane-tabs-context'
import type { SplitLayoutControls } from '../use-split-working-set'

vi.mock('@/components/chat/file-view', () => ({
  FileView: ({ path }: { path: string }) => <div data-testid="file-view">{path}</div>,
}))

vi.mock('@/components/peek/todo-tab-view', () => ({
  TodoTabView: ({ todoId }: { todoId: string }) => <div data-testid="todo-view">{todoId}</div>,
}))

vi.mock('@/lib/todo-preview', () => ({
  useTodoPreview: () => ({ data: { workItem: { title: 'Write the notes' } } }),
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
    focusPane: vi.fn(),
  } as SplitLayoutControls)
  return { onSelect, controls, set, get layout() { return layout }, bind: (fn: () => void) => { rerender = fn } }
}

function Probe({ sessionId, keepId }: { sessionId: string; keepId?: string }) {
  const strip = usePaneTabsStrip(sessionId)
  const keep = usePaneTabsKeep()
  const file = usePaneShownDoc(sessionId)
  return (
    <div>
      {strip}
      {file?.kind === 'file' ? <output data-testid="shown-file">{file.file.path}</output> : null}
      {file?.kind === 'todo' ? <output data-testid="shown-todo">{file.todoId}</output> : null}
      <button type="button" onClick={() => keepId && keep(keepId)}>work</button>
    </div>
  )
}

function TitleDragProbe({ tabId }: { tabId: string }) {
  return <output data-testid={`drag-${tabId}`}>{String(usePaneTitleDrag(tabId)?.draggable ?? false)}</output>
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
    const h = harness(openDocTab(twoTabs(), 'a', report))
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
    const h = harness(openDocTab(twoTabs(), 'x', report))
    render(<Mount h={h} sessionId="x" />)
    fireEvent.click(screen.getByLabelText('Close tab Xray'))
    expect(groupsOf(h.layout)[0].tabs).toEqual(['a', report])
    expect(h.onSelect).toHaveBeenLastCalledWith('a')
  })

  it('a sidebar chat dropped into the strip is shown and becomes the route', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    const h = harness(openDocTab(createSplitLayout(['a'], 'a'), 'a', report))
    render(<Mount h={h} sessionId="a" />)
    dropOn(screen.getByTestId('pane-tab-strip'), { [CHAT_SESSION_DND_MIME]: 'x' })
    expect(groupsOf(h.layout)[0]).toMatchObject({ tabs: ['a', report, 'x'], activeTab: 'x' })
    expect(h.onSelect).toHaveBeenLastCalledWith('x')
  })

  it('a file tab dragged into another pane routes to that pane\'s chat', () => {
    const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })
    const start = focusSession(openDocTab(createSplitLayout(['a', 'x'], 'a'), 'a', report), 'x')
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
      const arranged = openDocTab(materializeLayout(createSplitLayout(['a', 'x'], 'a'), 2), 'a', report)
      return splitGroup(arranged, groupOfSession(arranged, 'a')!.id, 'right', report)
    }

    function FilePaneProbe({ paneKey }: { paneKey: string }) {
      return <div>{usePaneTabsDocPane()(paneKey)}</div>
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

    it('renders a lone file under a plain title bar, no strip, which drags it like its tab', async () => {
      const h = harness(splitOut())
      render(<MountFile h={h} paneKey={report} />)
      expect((await screen.findByTestId('file-view')).textContent).toBe('docs/report.md')
      expect(screen.queryByTestId('pane-tab-strip')).toBeNull()
      const title = screen.getByTestId('doc-pane-title')
      expect(title.textContent).toContain('report.md')
      expect(title.getAttribute('draggable')).toBe('true')
    })

    it('shows a strip once the pane holds a second document', () => {
      const notes = fileTabId({ path: 'docs/notes.md', sessionId: 'a' })
      const layout = splitOut()
      const h = harness(placeTab(openDocTab(layout, 'a', notes), groupOfSession(layout, report)!.id, notes))
      render(<MountFile h={h} paneKey={notes} />)
      expect(screen.getByTestId('pane-tab-strip').querySelectorAll('[role="tab"]')).toHaveLength(2)
      expect(screen.queryByTestId('doc-pane-title')).toBeNull()
    })

    it('renders nothing for a pane key that is no file-only pane', () => {
      const h = harness(splitOut())
      render(<MountFile h={h} paneKey="a" />)
      expect(screen.queryByTestId('file-pane')).toBeNull()
    })

    it('closing its tab closes the pane and leaves the route where it was', () => {
      const h = harness(splitOut())
      render(<MountFile h={h} paneKey={report} />)
      fireEvent.click(screen.getByLabelText('Close report.md'))
      expect(groupOfSession(h.layout, report)).toBeNull()
      expect(h.onSelect).not.toHaveBeenCalledWith(report)
    })

    it('closing the route\'s chat tab while the file pane holds focus still moves the route on', () => {
      const tabbed = openInFocusedGroup(createSplitLayout(['a'], 'a'), 'x')
      const withFile = openDocTab(tabbed, 'x', report)
      const h = harness(splitGroup(materializeLayout(withFile, 1), groupOfSession(withFile, 'x')!.id, 'right', report))
      expect(h.layout.focusedGroupId).toBe(groupOfSession(h.layout, report)!.id)
      render(<Mount h={h} sessionId="x" />)
      fireEvent.click(screen.getByLabelText('Close tab Xray'))
      expect(groupOfSession(h.layout, 'x')).toBeNull()
      expect(h.onSelect).toHaveBeenLastCalledWith('a')
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

  it('shows no strip for the lone pane of a new chat, whose title bar drags it instead', () => {
    const layout = openNewChatTab(createSplitLayout(['a'], 'a'))
    const fresh = groupsOf(layout)[0].tabs.find(isNewChatTabId)!
    const h = harness(splitGroup(layout, groupsOf(layout)[0].id, 'right', fresh))
    render(<Mount h={h} sessionId={fresh} />)
    expect(screen.queryByTestId('pane-tab-strip')).toBeNull()
    render(<PaneTabsProvider split={h.controls()} onSelect={h.onSelect}><TitleDragProbe tabId={fresh} /><TitleDragProbe tabId="a" /></PaneTabsProvider>)
    expect(screen.getByTestId(`drag-${fresh}`).textContent).toBe('true')
    // A lone chat's pane drags by its title bar too; a pane with a strip drags by its tabs.
    expect(screen.getByTestId('drag-a').textContent).toBe('true')
  })

  it('gives a pane with a strip no title-bar drag, and starts the drag of a lone pane as its tab would', () => {
    const tabbed = harness(twoTabs())
    render(<PaneTabsProvider split={tabbed.controls()} onSelect={tabbed.onSelect}><TitleDragProbe tabId="x" /></PaneTabsProvider>)
    expect(screen.getByTestId('drag-x').textContent).toBe('false')

    const lone = harness(createSplitLayout(['a'], 'a'))
    let drag: ReturnType<typeof usePaneTitleDrag> = null
    function Capture() { drag = usePaneTitleDrag('a'); return null }
    render(<PaneTabsProvider split={lone.controls()} onSelect={lone.onSelect}><Capture /></PaneTabsProvider>)
    const data = new Map<string, string>()
    const dataTransfer = { get types() { return [...data.keys()] }, setData: (type: string, value: string) => { data.set(type, value) }, effectAllowed: 'none' }
    const bar = document.createElement('div')
    drag!.onDragStart({ dataTransfer, currentTarget: bar, target: bar } as never)
    expect(JSON.parse(data.get(PANE_TAB_DND_MIME)!)).toEqual({ groupId: groupsOf(lone.layout)[0].id, tabId: 'a' })
    expect(data.get(CHAT_SESSION_DND_MIME)).toBe('a')
    drag!.onDragEnd()

    // A drag out of a portaled menu bubbles through the bar but did not start in it: no tab drag.
    data.clear()
    drag!.onDragStart({ dataTransfer, currentTarget: bar, target: document.createElement('div') } as never)
    expect(data.size).toBe(0)
  })

  it('shows a Todo tab over its chat, titled from the preview cache', () => {
    const h = harness(openDocTab(twoTabs(), 'x', todoTabId('ACM-1')))
    render(<Mount h={h} sessionId="x" />)
    expect(screen.getByTestId('shown-todo').textContent).toBe('ACM-1')
    expect(screen.getByRole('tab', { name: /ACM-1/ }).textContent).toBe('ACM-1 Write the notes')
  })
})
