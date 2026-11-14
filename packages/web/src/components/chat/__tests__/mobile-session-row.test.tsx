import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const sidebarData = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
}))

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: sidebarData.sessions, isLoading: false }),
  usePinnedSessions: () => ({ data: [] }),
  useSessionCounts: () => ({ data: { counts: {}, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useArchiveSession: () => ({ mutateAsync: vi.fn() }),
  useUnarchiveSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: vi.fn() }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: new Set<string>() }),
  useTogglePin: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    getOrg: () => Promise.resolve({ employees: [] }),
    getEmployee: () => Promise.resolve({}),
  },
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Hundredfold', employeeOverrides: {} } }),
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))

// Radix renders its menu in a portal behind real pointer events; inlining the
// content lets the test assert WHICH actions the trigger offers, which is the
// part that matters here — the menu opening for real is checked in the browser.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

import { MemoryRouter } from 'react-router-dom'
import { ChatSidebar } from '../chat-sidebar'
import { MobileSessionRow } from '../mobile-session-row'
import { COMMIT_RATIO } from '../use-swipe-actions'

const SESSION = {
  id: 'session-1',
  title: 'Ship the mobile list',
  employee: 'researcher',
  source: 'web',
  // Today's bucket — an older session sits inside the collapsed Older drawer and
  // renders no row at all.
  lastActivity: new Date().toISOString(),
}

function rowProps(overrides: Record<string, unknown> = {}) {
  return {
    session: SESSION,
    avatarName: 'researcher',
    displayName: 'Researcher',
    selectedId: null,
    readSessions: new Set<string>(['session-1']),
    pinnedSessions: new Set<string>(),
    renamingSessionId: null,
    renameCancelledRef: { current: false },
    fixTitle: (title?: string) => title ?? '',
    onSelect: vi.fn(),
    togglePin: vi.fn(),
    handleDuplicate: vi.fn(),
    handleStop: vi.fn(),
    handleArchive: vi.fn(),
    setDeleteTarget: vi.fn(),
    setRenamingSessionId: vi.fn(),
    updateSessionTitle: vi.fn(),
    ...overrides,
  }
}

function renderRow(overrides: Record<string, unknown> = {}) {
  const props = rowProps(overrides)
  render(withQueryClient(<MemoryRouter><MobileSessionRow {...props} /></MemoryRouter>))
  return props
}

const rowBody = () => screen.getByRole('button', { name: /Researcher/ })

/** Drag the row horizontally by `dx` and let go. */
function swipe(dx: number) {
  const body = rowBody()
  fireEvent.pointerDown(body, { clientX: 300, clientY: 100 })
  fireEvent.pointerMove(window, { clientX: 300 + dx, clientY: 100 })
  fireEvent.pointerUp(window)
}

describe('ChatSidebar row variant', () => {
  beforeEach(() => {
    sidebarData.sessions = [SESSION]
  })

  it('renders the touch row only for the mobile variant', () => {
    const desktop = render(withQueryClient(<MemoryRouter><ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} /></MemoryRouter>))
    expect(desktop.container.querySelector('[data-row="mobile"]')).toBeNull()
    const desktopHtml = desktop.container.innerHTML
    desktop.unmount()

    const explicit = render(withQueryClient(<MemoryRouter><ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} variant="desktop" /></MemoryRouter>))
    // The default variant IS the desktop variant: naming it changes nothing.
    expect(explicit.container.innerHTML).toBe(desktopHtml)
    explicit.unmount()

    const mobile = render(withQueryClient(<MemoryRouter><ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} variant="mobile" /></MemoryRouter>))
    expect(mobile.container.querySelector('[data-row="mobile"]')).not.toBeNull()
    expect(mobile.container.innerHTML).not.toBe(desktopHtml)
  })
})

describe('MobileSessionRow', () => {
  it('shows the actions trigger at rest, offering every swipe action without a swipe', () => {
    renderRow()
    expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy()
    for (const action of ['Pin', 'Archive chat', 'Delete session']) {
      expect(screen.getByText(action)).toBeTruthy()
    }
  })

  it('presses on pointer-down, before any click, and lets go on pointer-up', () => {
    const props = renderRow()
    const body = rowBody()
    const cell = body.parentElement!
    expect(cell.hasAttribute('data-pressed')).toBe(false)

    fireEvent.pointerDown(body, { clientX: 300, clientY: 100 })
    expect(cell.hasAttribute('data-pressed')).toBe(true)
    expect(props.onSelect).not.toHaveBeenCalled()

    fireEvent.pointerUp(window)
    expect(cell.hasAttribute('data-pressed')).toBe(false)
  })

  it('reveals the trailing actions on a committed swipe and keeps them until dismissed', () => {
    renderRow()
    expect(screen.queryByTestId('swipe-rail-trailing')).toBeNull()

    swipe(-160)
    expect(screen.getByTestId('swipe-rail-trailing')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()

    // A short drag on an already-open row must not close it by accident.
    swipe(10)
    expect(screen.getByTestId('swipe-rail-trailing')).toBeTruthy()
  })

  it('mounts only the rail the swipe uncovered — the far one shows through a selected row', () => {
    renderRow({ selectedId: 'session-1' })
    swipe(-160)
    expect(screen.getByTestId('swipe-rail-trailing')).toBeTruthy()
    expect(screen.queryByTestId('swipe-rail-leading')).toBeNull()

    swipe(200)
    expect(screen.getByTestId('swipe-rail-leading')).toBeTruthy()
    expect(screen.queryByTestId('swipe-rail-trailing')).toBeNull()
  })

  it('snaps back from a drag that never commits, and ignores a vertical one', () => {
    renderRow()
    swipe(-(156 * COMMIT_RATIO - 4))
    expect(screen.queryByTestId('swipe-rail-trailing')).toBeNull()

    const body = rowBody()
    fireEvent.pointerDown(body, { clientX: 300, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 280, clientY: 260 })
    fireEvent.pointerUp(window)
    expect(screen.queryByTestId('swipe-rail-trailing')).toBeNull()
  })

  it('asks for confirmation instead of deleting when the swipe action is tapped', () => {
    const props = renderRow()
    swipe(-160)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(props.setDeleteTarget).toHaveBeenCalledWith({
      type: 'session',
      id: 'session-1',
      label: 'Ship the mobile list',
    })
    // Nothing else fired: the row hands the decision to the confirm dialog.
    expect(props.handleArchive).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('swallows the click that ends the drag, then spends the next tap dismissing', () => {
    const props = renderRow()
    swipe(-160)

    // The release itself clicks whatever was under the finger; that click must
    // neither open the chat nor undo the swipe that just landed.
    fireEvent.click(rowBody())
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(screen.queryByTestId('swipe-rail-trailing')).not.toBeNull()

    fireEvent.click(rowBody())
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(screen.queryByTestId('swipe-rail-trailing')).toBeNull()

    fireEvent.click(rowBody())
    expect(props.onSelect).toHaveBeenCalledWith('session-1')
  })
})
