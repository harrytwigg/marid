import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Behavior of the refactored chat list (title-first rows):
//  • Pinned folds behind "N more pinned" past PINNED_VISIBLE
//  • Scheduled is one link-row to /cron, never per-session rows
//  • automated/delegated sessions never flood the recency buckets — All mode
//    reveals them as per-employee Team groups instead

const sidebarData = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  counts: {} as Record<string, number>,
  pins: new Set<string>(),
  archiveSpy: vi.fn(async (_id: string) => ({})),
  bulkDeleteSpy: vi.fn(async (_ids: string[]) => ({ status: 'deleted', count: 0 })),
  removedSpy: vi.fn(),
}))

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: sidebarData.sessions, isLoading: false }),
  usePinnedSessions: () => ({ data: [] }),
  useSessionCounts: () => ({ data: { counts: sidebarData.counts, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useArchiveSession: () => ({ mutateAsync: sidebarData.archiveSpy }),
  useUnarchiveSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: sidebarData.bulkDeleteSpy }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: sidebarData.pins }),
  useTogglePin: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    getOrg: () => Promise.resolve({ employees: [] }),
    getEmployee: () => Promise.resolve({}),
  },
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Jinn', employeeOverrides: {} } }),
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

import { MemoryRouter } from 'react-router-dom'
import { ChatSidebar, PINNED_VISIBLE } from '../chat-sidebar'
import { CHAT_SESSION_DND_MIME } from '@/routes/chat/chat-session-dnd'

const NOW = new Date().toISOString()

function webSession(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, source: 'web', lastActivity: NOW, ...extra }
}

function renderSidebar(variant: 'desktop' | 'mobile' = 'desktop') {
  return render(withQueryClient(
    <MemoryRouter>
      <ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} onSessionsRemoved={sidebarData.removedSpy} variant={variant} />
    </MemoryRouter>,
  ))
}

beforeEach(() => {
  localStorage.clear()
  sidebarData.sessions = []
  sidebarData.counts = {}
  sidebarData.pins = new Set()
  sidebarData.archiveSpy.mockClear()
  sidebarData.bulkDeleteSpy.mockClear()
  sidebarData.removedSpy.mockClear()
  sidebarData.archiveSpy.mockImplementation(async (_id: string) => ({}))
  sidebarData.bulkDeleteSpy.mockImplementation(async (_ids: string[]) => ({ status: 'deleted', count: 0 }))
})

describe('pinned section cap', () => {
  it('publishes only session identity from desktop rows and leaves mobile rows non-draggable', () => {
    sidebarData.sessions = [webSession('chat-1', 'Drag this chat')]
    const desktop = renderSidebar()
    const row = desktop.container.querySelector<HTMLElement>('[data-chat-session-row="chat-1"]')!
    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'uninitialized' } as unknown as DataTransfer
    fireEvent.dragStart(row, { dataTransfer })
    expect(row.getAttribute('draggable')).toBe('true')
    expect(setData).toHaveBeenCalledOnce()
    expect(setData).toHaveBeenCalledWith(CHAT_SESSION_DND_MIME, 'chat-1')
    expect(dataTransfer.effectAllowed).toBe('copy')
    desktop.unmount()

    const mobile = renderSidebar('mobile')
    expect(mobile.container.querySelector('[data-chat-session-row="chat-1"]')).toBeNull()
    expect(mobile.container.querySelector('[draggable="true"]')).toBeNull()
  })

  it('folds pins beyond PINNED_VISIBLE behind "N more pinned" and expands on demand', () => {
    const total = PINNED_VISIBLE + 3
    sidebarData.sessions = Array.from({ length: total }, (_, i) =>
      webSession(`pin-${i}`, `Pinned chat ${i}`))
    sidebarData.pins = new Set(sidebarData.sessions.map((s) => s.id as string))

    renderSidebar()
    expect(screen.getAllByText(/^Pinned chat /)).toHaveLength(PINNED_VISIBLE)

    const more = screen.getByRole('button', { name: '3 more pinned' })
    fireEvent.click(more)
    expect(screen.getAllByText(/^Pinned chat /)).toHaveLength(total)
    expect(screen.getByRole('button', { name: 'Show fewer pinned' })).toBeTruthy()
  })

  it('shows every pin without a fold row at or below the cap', () => {
    sidebarData.sessions = Array.from({ length: PINNED_VISIBLE }, (_, i) =>
      webSession(`pin-${i}`, `Pinned chat ${i}`))
    sidebarData.pins = new Set(sidebarData.sessions.map((s) => s.id as string))

    renderSidebar()
    expect(screen.getAllByText(/^Pinned chat /)).toHaveLength(PINNED_VISIBLE)
    expect(screen.queryByText(/more pinned/)).toBeNull()
  })
})

describe('scheduled link-row', () => {
  it('renders cron sessions as one link to /cron, not as list rows', () => {
    sidebarData.sessions = [
      webSession('chat-1', 'My own chat'),
      { id: 'cron-1', title: 'Nightly digest', source: 'cron', sourceRef: 'cron:digest', lastActivity: NOW },
    ]
    sidebarData.counts = { __cron__: 1345 }

    renderSidebar()
    expect(screen.queryByText('Nightly digest')).toBeNull()
    const link = screen.getByRole('link', { name: /Scheduled runs · 1,345/ })
    expect(link.getAttribute('href')).toBe('/cron')
  })

  it('still floats a pinned cron session into Pinned', () => {
    sidebarData.sessions = [
      { id: 'cron-1', title: 'Nightly digest', source: 'cron', sourceRef: 'cron:digest', lastActivity: NOW },
    ]
    sidebarData.pins = new Set(['cron-1'])

    renderSidebar()
    expect(screen.getByText('Nightly digest')).toBeTruthy()
    expect(screen.getByText('Pinned')).toBeTruthy()
  })
})

describe('automated sessions and the Team directory', () => {
  const OWN = webSession('own-1', 'Talk Orb Refinement')
  const CHILD = webSession('child-1', 'IMPLEMENT PHASE — round 1', {
    employee: 'jinn-dev',
    parentSessionId: 'own-1',
  })

  it('shows delegated children as flat rows in All mode (all means all)', () => {
    sidebarData.sessions = [OWN, CHILD]

    renderSidebar()
    // Default mode is All: the child is findable as a flat recency row AND
    // inside its Team group (the grouped view keeps full per-employee history).
    expect(screen.getByText('Talk Orb Refinement')).toBeTruthy()
    expect(screen.getByText('IMPLEMENT PHASE — round 1')).toBeTruthy()
    expect(screen.getByText('Team')).toBeTruthy()
    expect(screen.getByText('Jinn Dev')).toBeTruthy()
  })

  it('hides delegated children and the Team directory in Focused mode', () => {
    localStorage.setItem('jinn-sidebar-focus-mode', 'focused')
    sidebarData.sessions = [OWN, CHILD]

    renderSidebar()
    expect(screen.getByText('Talk Orb Refinement')).toBeTruthy()
    expect(screen.queryByText('IMPLEMENT PHASE — round 1')).toBeNull()
    expect(screen.queryByText('Jinn Dev')).toBeNull()
  })

  const WF_RUN = { id: 'wf-1', title: 'Nightly digest run', source: 'workflow', sourceRef: 'wfrun:x', employee: 'jinn-dev', lastActivity: NOW }

  it('surfaces workflow runs as first-class rows in All mode', () => {
    sidebarData.sessions = [OWN, WF_RUN]

    renderSidebar()
    expect(screen.getByText('Nightly digest run')).toBeTruthy()
  })

  it('keeps workflow runs out of Focused mode, like every automated session', () => {
    localStorage.setItem('jinn-sidebar-focus-mode', 'focused')
    sidebarData.sessions = [OWN, WF_RUN]

    renderSidebar()
    expect(screen.queryByText('Nightly digest run')).toBeNull()
  })

  it('expands an employee group to its sessions on click', () => {
    sidebarData.sessions = [
      OWN,
      CHILD,
      webSession('child-2', 'PLAN PHASE — planning only', { employee: 'jinn-dev', parentSessionId: 'own-1' }),
    ]

    renderSidebar()
    fireEvent.click(screen.getByText('Jinn Dev'))
    // Each child now also renders as a flat All-mode row, so the expanded
    // group makes it a second match.
    expect(screen.getAllByText('IMPLEMENT PHASE — round 1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PLAN PHASE — planning only').length).toBeGreaterThan(0)
  })
})

describe('multi-select', () => {
  const A = webSession('sel-a', 'Alpha chat')
  const B = webSession('sel-b', 'Beta chat')
  const C = webSession('sel-c', 'Gamma chat')

  /** Enter selection mode from the control band's "Select chats" affordance. */
  function enterSelection() {
    fireEvent.click(screen.getByRole('button', { name: 'Select chats' }))
  }

  function checkbox(label: string) {
    return screen.getByRole('checkbox', { name: `Select ${label}` })
  }

  // The recency buckets are relative to the run's wall clock: only Today and
  // Yesterday render flat rows, anything older collapses into the "Older"
  // section and their checkboxes are not in the DOM. A hardcoded date put these
  // three rows in that collapsed section the moment the calendar moved on, so
  // pin them inside today — newest first — and the ordered range is the same on
  // every run date.
  function recencyRows() {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    return [
      webSession('sel-a', 'Alpha chat', { lastActivity: minutesAgo(1) }),
      webSession('sel-b', 'Beta chat', { lastActivity: minutesAgo(2) }),
      webSession('sel-c', 'Gamma chat', { lastActivity: minutesAgo(3) }),
    ]
  }

  it('toggles rows in and out of the selection and counts them', () => {
    sidebarData.sessions = [A, B, C]
    renderSidebar()
    enterSelection()

    expect(screen.getByText('Select chats')).toBeTruthy()
    // A session row's click opens the chat; in selection mode it selects it.
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Beta chat'))
    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(checkbox('Alpha chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Gamma chat').getAttribute('aria-checked')).toBe('false')

    fireEvent.click(checkbox('Beta chat'))
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('shift-click extends the selection from the anchor to the clicked row', () => {
    sidebarData.sessions = recencyRows()
    renderSidebar()
    enterSelection()

    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Gamma chat'), { shiftKey: true })

    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(checkbox('Alpha chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Beta chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Gamma chat').getAttribute('aria-checked')).toBe('true')
  })

  it('recomputes the range from the same anchor on a later shift-click', () => {
    sidebarData.sessions = recencyRows()
    renderSidebar()
    enterSelection()

    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Gamma chat'), { shiftKey: true })
    // The anchor stays on Alpha, so the second range replaces the first
    // rather than unioning Alpha–Gamma with Alpha–Beta.
    fireEvent.click(checkbox('Beta chat'), { shiftKey: true })

    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(checkbox('Alpha chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Beta chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Gamma chat').getAttribute('aria-checked')).toBe('false')
  })

  it('moves the anchor on a plain click so a later shift-click ranges from it', () => {
    sidebarData.sessions = recencyRows()
    renderSidebar()
    enterSelection()

    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Beta chat'))
    fireEvent.click(checkbox('Gamma chat'), { shiftKey: true })

    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(checkbox('Alpha chat').getAttribute('aria-checked')).toBe('false')
    expect(checkbox('Beta chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Gamma chat').getAttribute('aria-checked')).toBe('true')
  })

  it('ranges across a section header without selecting it', () => {
    // Alpha and Beta are today, Gamma is yesterday, so a "Yesterday" header sits
    // between Beta and Gamma in render order. A range must span it without the
    // header counting as a selectable row.
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12, 0, 0)
    sidebarData.sessions = [
      webSession('sel-a', 'Alpha chat', { lastActivity: new Date(today.getTime() - 60_000).toISOString() }),
      webSession('sel-b', 'Beta chat', { lastActivity: new Date(today.getTime() - 120_000).toISOString() }),
      webSession('sel-c', 'Gamma chat', { lastActivity: yesterday.toISOString() }),
    ]
    renderSidebar()
    enterSelection()

    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Gamma chat'), { shiftKey: true })

    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(checkbox('Alpha chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Beta chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Gamma chat').getAttribute('aria-checked')).toBe('true')
  })

  it('ranges upward when the anchor sits below the shift-clicked row', () => {
    const today = new Date()
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12, 0, 0)
    sidebarData.sessions = [
      webSession('sel-a', 'Alpha chat', { lastActivity: new Date(today.getTime() - 60_000).toISOString() }),
      webSession('sel-b', 'Beta chat', { lastActivity: new Date(today.getTime() - 120_000).toISOString() }),
      webSession('sel-c', 'Gamma chat', { lastActivity: yesterday.toISOString() }),
    ]
    renderSidebar()
    enterSelection()

    // Anchor on Gamma (yesterday), then shift-click Alpha (today, above it).
    fireEvent.click(checkbox('Gamma chat'))
    fireEvent.click(checkbox('Alpha chat'), { shiftKey: true })

    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(checkbox('Alpha chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Beta chat').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Gamma chat').getAttribute('aria-checked')).toBe('true')
  })

  it('treats a shift-click with no anchor as an ordinary toggle', () => {
    sidebarData.sessions = [A, B]
    renderSidebar()
    enterSelection()

    fireEvent.click(checkbox('Beta chat'), { shiftKey: true })

    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(checkbox('Beta chat').getAttribute('aria-checked')).toBe('true')
  })

  it('disables both batch actions until something is selected', () => {
    sidebarData.sessions = [A, B]
    renderSidebar()
    enterSelection()

    expect(screen.getByRole('button', { name: 'Archive selected chats' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Delete selected chats' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(checkbox('Alpha chat'))
    expect(screen.getByRole('button', { name: 'Archive selected chats' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Delete selected chats' }).hasAttribute('disabled')).toBe(false)
  })

  it('archives every selected session and leaves selection mode', async () => {
    sidebarData.sessions = [A, B, C]
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Gamma chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Archive selected chats' }))

    await vi.waitFor(() => expect(sidebarData.archiveSpy).toHaveBeenCalledTimes(2))
    expect(sidebarData.archiveSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['sel-a', 'sel-c'])
    // Back to the resting band: the batch is cleared, not left armed.
    await vi.waitFor(() => expect(screen.queryByText('2 selected')).toBeNull())
    expect(screen.getByRole('button', { name: 'Search chats' })).toBeTruthy()
  })

  it('confirms before a bulk delete, naming the count, and deletes on confirm', async () => {
    sidebarData.sessions = [A, B, C]
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Beta chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected chats' }))
    // The irreversible step is gated: nothing has been deleted yet.
    expect(screen.getByText('Delete 2 selected chats?')).toBeTruthy()
    expect(sidebarData.bulkDeleteSpy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await vi.waitFor(() => expect(sidebarData.bulkDeleteSpy).toHaveBeenCalledTimes(1))
    expect(sidebarData.bulkDeleteSpy.mock.calls[0]![0].sort()).toEqual(['sel-a', 'sel-b'])
  })

  it('cancelling the bulk delete confirmation deletes nothing', () => {
    sidebarData.sessions = [A, B]
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected chats' }))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete 1 selected chats?')).toBeNull()
    expect(sidebarData.bulkDeleteSpy).not.toHaveBeenCalled()
  })

  it('cancel clears the batch and restores the normal list', () => {
    sidebarData.sessions = [A, B]
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel selection' }))
    expect(screen.queryByText('1 selected')).toBeNull()
    expect(screen.getByRole('button', { name: 'Search chats' })).toBeTruthy()
  })

  it('keeps archiving after one session is refused (a running chat must not sink the batch)', async () => {
    sidebarData.sessions = [A, B, C]
    // The gateway answers 409 for a running/waiting chat; the first refusal must
    // not abort the ids after it.
    sidebarData.archiveSpy.mockImplementation(async (id: string) => {
      if (id === 'sel-a') throw new Error('Cannot archive a chat while it is running or waiting')
      return {}
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Beta chat'))
    fireEvent.click(checkbox('Gamma chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Archive selected chats' }))

    await vi.waitFor(() => expect(sidebarData.archiveSpy).toHaveBeenCalledTimes(3))
    expect(sidebarData.archiveSpy.mock.calls.map((c) => c[0]).sort()).toEqual(['sel-a', 'sel-b', 'sel-c'])
    // Only the sessions that actually left are handed to the page.
    expect(sidebarData.removedSpy).toHaveBeenCalledWith(['sel-b', 'sel-c'])
    // A partial batch is surfaced, not silently indistinguishable from a full one.
    await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(alertSpy.mock.calls[0]![0]).toContain('1 of 3')
    alertSpy.mockRestore()
  })

  it('does not report removed ids when every archive is refused', async () => {
    sidebarData.sessions = [A, B]
    sidebarData.archiveSpy.mockImplementation(async () => { throw new Error('refused') })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Beta chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Archive selected chats' }))

    await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(sidebarData.removedSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  it('hands the deleted ids to the page so stale working-set panes are dropped', async () => {
    sidebarData.sessions = [A, B]
    renderSidebar()
    enterSelection()
    fireEvent.click(checkbox('Alpha chat'))
    fireEvent.click(checkbox('Beta chat'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await vi.waitFor(() => expect(sidebarData.removedSpy).toHaveBeenCalledWith(['sel-a', 'sel-b']))
  })
})
