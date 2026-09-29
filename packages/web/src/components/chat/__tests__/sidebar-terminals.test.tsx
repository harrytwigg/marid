import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'

// The sidebar's Terminals section: terminal sessions leave the chat
// buckets for their own section, whose header opens a shell on any host the
// gateway reports — here or beside the current chat.

const data = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  hosts: { enabled: true, hosts: [] as Record<string, unknown>[], problems: [] as string[] },
  createTerminal: vi.fn(async (_hostId: string) => ({ id: 'term-new' }) as Record<string, unknown>),
}))

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: data.sessions, isLoading: false }),
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

vi.mock('@/lib/api-terminals', () => ({
  terminalsApi: {
    listTerminalHosts: () => Promise.resolve(data.hosts),
    createTerminal: (hostId: string) => data.createTerminal(hostId),
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
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="menu">{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button type="button" onClick={onClick}>{children}</button>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

import { MemoryRouter } from 'react-router-dom'
import { ChatSidebar } from '../chat-sidebar'

const NOW = new Date().toISOString()

function renderSidebar(props: { onSelect?: (id: string) => void; onOpenBeside?: (id: string) => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChatSidebar selectedId={null} onSelect={props.onSelect ?? vi.fn()} onNewChat={vi.fn()} onOpenBeside={props.onOpenBeside} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  data.sessions = []
  data.hosts = { enabled: true, hosts: [], problems: [] }
  data.createTerminal.mockClear()
})

describe('sidebar Terminals section', () => {
  it('lists terminal sessions in their own section, not among today\'s chats', async () => {
    data.sessions = [
      { id: 'chat-1', title: 'A real chat', source: 'web', lastActivity: NOW },
      { id: 'term-1', title: 'gateway-host', source: 'terminal', engine: 'terminal', sourceRef: 'local', lastActivity: NOW },
    ]
    const { container } = renderSidebar()
    const header = await waitFor(() => container.querySelector('[data-sidebar-terminals]')!)
    expect(within(header as HTMLElement).getByText('Terminals')).toBeTruthy()
    const rows = [...container.querySelectorAll('[data-chat-session-row]')].map((el) => el.getAttribute('data-chat-session-row'))
    // The terminal row renders once, after the chats (below its header).
    expect(rows.filter((id) => id === 'term-1')).toHaveLength(1)
    expect(rows.indexOf('term-1')).toBeGreaterThan(rows.indexOf('chat-1'))
    const today = screen.getByText('Today').parentElement!
    expect(today.textContent).toContain('1')
  })

  it('hides the section when there are no hosts and no terminals', async () => {
    data.hosts = { enabled: false, hosts: [], problems: [] }
    const { container } = renderSidebar()
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector('[data-sidebar-terminals]')).toBeNull()
  })

  it('opens a terminal on the chosen host and selects it', async () => {
    data.hosts = {
      enabled: true,
      hosts: [
        { id: 'local', label: 'gateway-host', kind: 'local', detail: 'This gateway' },
        { id: 'build', label: 'Build host', kind: 'ssh', detail: 'builder@10.0.0.5' },
      ],
      problems: [],
    }
    const onSelect = vi.fn()
    renderSidebar({ onSelect })
    const menu = await screen.findByTestId('menu')
    expect(within(menu).getByText('This gateway')).toBeTruthy()
    fireEvent.click(within(menu).getByText('Build host'))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('term-new'))
    expect(data.createTerminal).toHaveBeenCalledWith('build')
  })

  it('opens a terminal beside the current chat when asked', async () => {
    data.hosts = { enabled: true, hosts: [{ id: 'local', label: 'gateway-host', kind: 'local' }], problems: [] }
    const onSelect = vi.fn()
    const onOpenBeside = vi.fn()
    renderSidebar({ onSelect, onOpenBeside })
    const menu = await screen.findByTestId('menu')
    const items = within(menu).getAllByText('gateway-host')
    expect(items).toHaveLength(2)
    fireEvent.click(items[1])
    await waitFor(() => expect(onOpenBeside).toHaveBeenCalledWith('term-new'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
