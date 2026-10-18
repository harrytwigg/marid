/**
 * A chat the session list does not carry keeps its tab.
 *
 * The list holds only unarchived chats, and only the newest of those, so a chat
 * opened from search (an archived one, or an old one not paged in) is absent
 * from it. Absence used to close the tab whenever the list refetched, which
 * moved the active tab to its neighbour and dragged the URL after it: the chat
 * showed for a moment, then another one replaced it. Only a gateway lookup that
 * finds the chat deleted closes its tab now.
 *
 * The real route and the real tab model, with only the transport and the
 * sidebar stubbed: a stubbed tab model would stay green with the fix reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { queryKeys } from '@/lib/query-keys'

const LISTED = ['a', 'b']

const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  getSessions: vi.fn(),
  getPins: vi.fn(async () => ({ pins: [] })),
  getOrg: vi.fn(async () => ({ employees: [] })),
  getEngines: vi.fn(async () => ({
    engines: { claude: { name: 'claude', available: true, defaultModel: 'opus', models: [], supportsPty: true } },
  })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  getSessionQueue: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
  archiveSession: vi.fn(async () => ({})),
  unarchiveSession: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: apiMocks }
})

vi.mock('@/hooks/use-gateway', () => {
  const gateway = { events: [], connected: true, connectionSeq: 0, skillsVersion: 0, subscribe: () => () => {} }
  return { useGateway: () => gateway }
})

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

/** The sidebar reduced to a search result for an unlisted chat and a bulk archive of it. */
vi.mock('@/components/chat/chat-sidebar', () => ({
  ChatSidebar: ({ onSelect, onSessionsRemoved }: {
    onSelect: (id: string) => void
    onSessionsRemoved?: (ids: string[]) => void
  }) => (
    <div data-testid="chat-sidebar">
      <button type="button" data-testid="open-unlisted" onClick={() => onSelect('z')} />
      <button type="button" data-testid="bulk-archive" onClick={() => onSessionsRemoved?.(['z'])} />
    </div>
  ),
  pickDeleteFallbackId: () => null,
}))

import ChatPageWrapper from '../page'
import { ApiError } from '@/lib/api'

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="route-location">{location.pathname}{location.search}</output>
}

let client: QueryClient

function renderRoute(entry = '/?session=a') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <Routes><Route path="/" element={<ChatPageWrapper />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const location = () => screen.getByTestId('route-location').textContent
const storedTabs = () => (JSON.parse(localStorage.getItem('jinn-chat-tabs') ?? '{"tabs":[]}') as { tabs: Array<{ sessionId?: string; label?: string; status?: string }> }).tabs
const storedTabIds = () => storedTabs().map((tab) => tab.sessionId)

async function refetchSessionList() {
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.sessions.all }) })
}

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Title ${id}`, status: 'idle', engine: 'claude', messages: [], ...extra }
}

beforeEach(() => {
  localStorage.clear()
  // Each fetch reports new activity, as a live list does: an unchanged one keeps
  // its reference and re-runs nothing that depends on it.
  let fetches = 0
  apiMocks.getSessions.mockImplementation(async () => ({
    sessions: LISTED.map((id) => ({ id, title: `Title ${id}`, status: 'idle', lastActivity: String(++fetches) })),
    counts: {},
    perGroup: {},
  }))
  apiMocks.getSession.mockImplementation(async (id: string) => (
    id === 'z' ? session(id, { archivedAt: '2026-01-01T00:00:00.000Z' }) : session(id)
  ))
})

afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('a chat the session list does not carry', () => {
  it('stays open and selected when opened, through a refetch of the list', async () => {
    renderRoute()
    await waitFor(() => expect(apiMocks.getSessions).toHaveBeenCalled())
    await waitFor(() => expect(location()).toBe('/?session=a'))

    fireEvent.click(screen.getAllByTestId('open-unlisted')[0])
    await waitFor(() => expect(location()).toBe('/?session=z'))

    await refetchSessionList()
    await refetchSessionList()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

    expect(location()).toBe('/?session=z')
    expect(storedTabIds()).toContain('z')
  })

  it('keeps its tab on a reload that lands on it', async () => {
    localStorage.setItem('jinn-chat-tabs', JSON.stringify({
      tabs: [
        { kind: 'session', sessionId: 'a', label: 'A', status: 'idle', unread: false, pinned: true },
        { kind: 'session', sessionId: 'z', label: 'Z', status: 'idle', unread: false, pinned: true },
      ],
      activeIndex: 1,
    }))
    renderRoute('/?session=z')
    await waitFor(() => expect(apiMocks.getSessions).toHaveBeenCalled())
    await refetchSessionList()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

    expect(location()).toBe('/?session=z')
    expect(storedTabIds()).toEqual(['a', 'z'])
  })

  it('takes its title and status from the lookup when it is not the open chat', async () => {
    localStorage.setItem('jinn-chat-tabs', JSON.stringify({
      tabs: [
        { kind: 'session', sessionId: 'a', label: 'A', status: 'idle', unread: false, pinned: true },
        { kind: 'session', sessionId: 'z', label: 'Loading...', status: 'running', unread: false, pinned: true },
      ],
      activeIndex: 0,
    }))
    renderRoute('/?session=a')

    await waitFor(() => expect(storedTabs().find((tab) => tab.sessionId === 'z')).toMatchObject({ label: 'Title z', status: 'idle' }))
    expect(location()).toBe('/?session=a')
  })

  it('loses its tab once the gateway reports it deleted, and the route follows', async () => {
    apiMocks.getSession.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new ApiError(404, 'Session not found')
      return session(id)
    })
    localStorage.setItem('jinn-chat-tabs', JSON.stringify({
      tabs: [
        { kind: 'session', sessionId: 'a', label: 'A', status: 'idle', unread: false, pinned: true },
        { kind: 'session', sessionId: 'gone', label: 'Gone', status: 'idle', unread: false, pinned: true },
      ],
      activeIndex: 1,
    }))
    renderRoute('/?session=gone')

    await waitFor(() => expect(storedTabIds()).toEqual(['a']))
    await waitFor(() => expect(location()).toBe('/?session=a'))
  })

  it('keeps its tab when the lookup fails for any other reason', async () => {
    apiMocks.getSession.mockImplementation(async (id: string) => {
      if (id === 'z') throw new ApiError(503, 'Gateway unavailable')
      return session(id)
    })
    localStorage.setItem('jinn-chat-tabs', JSON.stringify({
      tabs: [
        { kind: 'session', sessionId: 'a', label: 'A', status: 'idle', unread: false, pinned: true },
        { kind: 'session', sessionId: 'z', label: 'Z', status: 'idle', unread: false, pinned: true },
      ],
      activeIndex: 0,
    }))
    renderRoute('/?session=a')
    await waitFor(() => expect(apiMocks.getSession).toHaveBeenCalledWith('z', expect.anything()))
    await refetchSessionList()

    expect(storedTabIds()).toEqual(['a', 'z'])
    expect(location()).toBe('/?session=a')
  })

  it('loses its tab when archived from the list, and the route leaves it', async () => {
    renderRoute()
    await waitFor(() => expect(location()).toBe('/?session=a'))

    fireEvent.click(screen.getAllByTestId('open-unlisted')[0])
    await waitFor(() => expect(location()).toBe('/?session=z'))

    fireEvent.click(screen.getAllByTestId('bulk-archive')[0])
    await waitFor(() => expect(storedTabIds()).not.toContain('z'))
    await waitFor(() => expect(location()).not.toBe('/?session=z'))
  })

  it('does not bring its tab back when its pane takes focus after the archive', async () => {
    renderRoute()
    await waitFor(() => expect(location()).toBe('/?session=a'))

    fireEvent.click(screen.getAllByTestId('open-unlisted')[0])
    await waitFor(() => expect(location()).toBe('/?session=z'))
    const pane = await waitFor(() => {
      const element = document.querySelector('[data-chat-pane-session="z"]')
      expect(element).not.toBeNull()
      return element as Element
    })

    // The pane is still mounted when the archive lands, and a focus that was scheduled when the
    // chat opened (the composer takes it a frame later, so under load it arrives late) reaches it.
    // That focus selected the chat again: its tab reopened and the route went back to it.
    fireEvent.click(screen.getAllByTestId('bulk-archive')[0])
    fireEvent.focusIn(pane)

    await waitFor(() => expect(location()).not.toBe('/?session=z'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(storedTabIds()).not.toContain('z')
    expect(location()).not.toBe('/?session=z')
  })
})
