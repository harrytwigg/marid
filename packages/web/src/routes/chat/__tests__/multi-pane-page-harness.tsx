import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { vi } from 'vitest'
import type { OrgData } from '@/lib/api'
import type { SessionWaitsResponse } from '@/lib/session-waits'
import ChatPageWrapper from '../page'
import { CHAT_SESSION_DND_MIME } from '../chat-session-dnd'

const { sessionIds } = vi.hoisted(() => ({ sessionIds: ['a', 'b', 'c', 'd'] }))
const gateway = vi.hoisted(() => ({
  listeners: new Set<(frame: { event: string; payload: unknown }) => void>(),
}))
const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (id: string) => ({
    id,
    title: `Title ${id}`,
    status: 'idle',
    engine: 'claude',
    engineSessionId: `engine-${id}`,
    messages: [{ id: `${id}-m1`, role: 'assistant', content: `transcript-${id}`, timestamp: 1 }],
  })),
  getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  getSessions: vi.fn(async () => ({
    sessions: sessionIds.map((id) => ({ id, title: `Title ${id}`, status: 'idle' })),
    counts: {},
    perGroup: {},
  })),
  getPins: vi.fn(async () => ({ pins: [] })),
  searchSessions: vi.fn(async (query: string) => sessionIds
    .filter((id) => `Title ${id}`.toLowerCase().includes(query.toLowerCase()))
    .map((id) => ({ id, title: `Title ${id}`, status: 'idle' }))),
  // Only the employees are read from the org here, and suites that need real
  // ones override this — so the mock is typed to what it actually supplies.
  getOrg: vi.fn(async (): Promise<Pick<OrgData, 'employees'>> => ({ employees: [] })),
  getEngines: vi.fn(async () => ({
    engines: {
      claude: { name: 'claude', available: true, defaultModel: 'opus', models: [], supportsPty: true },
    },
  })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  getSessionQueue: vi.fn(async () => []),
  getSessionWaits: vi.fn(async (id: string): Promise<SessionWaitsResponse> => ({ sessionId: id, generatedAt: new Date().toISOString(), items: [] })),
  createSession: vi.fn(async () => ({ id: 'e' })),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
  deleteSession: vi.fn(async () => ({})),
  duplicateSession: vi.fn(async (id: string) => ({ id: `${id}-copy`, title: `Copy of ${id}` })),
  archiveSession: vi.fn(async () => ({})),
  unarchiveSession: vi.fn(async () => ({})),
  stopSession: vi.fn(async () => ({})),
  pinChat: vi.fn(async () => ({})),
  unpinChat: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: apiMocks }
})

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({
    events: [],
    connected: true,
    connectionSeq: 0,
    skillsVersion: 0,
    subscribe: (listener: (frame: { event: string; payload: unknown }) => void) => {
      gateway.listeners.add(listener)
      return () => gateway.listeners.delete(listener)
    },
  }),
}))

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

/** The sidebar reduced to what the route reacts to: the loaded session list it
 *  primes the newest chat from, the computed order the pane suites navigate by,
 *  the rows the operator taps, and the two ways into the composer. Rows and the
 *  roster contact hang off the mobile instance only, so the desktop suites keep
 *  the surface they were written against. */
vi.mock('@/components/chat/chat-sidebar', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    ChatSidebar: ({ variant, onNewChat, onSelect, onSessionsLoaded, onOrderComputed, onContactEmployee }: {
      variant?: string
      onNewChat: () => void
      onSelect: (id: string) => void
      onSessionsLoaded?: (sessions: { id: string }[]) => void
      onOrderComputed?: (order: unknown) => void
      onContactEmployee?: (name: string) => void
    }) => {
      const announced = useRef(false)
      useEffect(() => {
        if (variant !== 'mobile' || announced.current) return
        announced.current = true
        onSessionsLoaded?.(sessionIds.map((id) => ({ id })))
      })
      useEffect(() => {
        onOrderComputed?.({ sessionIds, employeeNames: [], employeeSessionMap: {} })
      }, [onOrderComputed])
      return (
        <div data-testid="chat-sidebar">
          <button type="button" onClick={onNewChat}>Start empty chat</button>
          {variant === 'mobile' && sessionIds.map((id) => (
            <button key={id} type="button" data-testid={`list-row-${id}`} onClick={() => onSelect(id)} />
          ))}
          {variant === 'mobile' && (
            <button type="button" data-testid="contact-employee" onClick={() => onContactEmployee?.('alpha')} />
          )}
        </div>
      )
    },
    pickDeleteFallbackId: () => null,
  }
})

vi.mock('@/hooks/use-chat-tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-tabs')>()
  const tabs = sessionIds.map((sessionId) => ({
    kind: 'session' as const,
    sessionId,
    label: sessionId,
    status: 'idle' as const,
    unread: false,
  }))
  const noop = () => {}
  return {
    ...actual,
    useChatTabs: () => ({
      tabs,
      activeTab: tabs[0],
      activeIndex: 0,
      hydrated: true,
      openTab: noop,
      openFileTab: noop,
      closeTab: noop,
      switchTab: noop,
      nextTab: noop,
      prevTab: noop,
      pinTab: noop,
      moveTab: noop,
      clearActiveTab: noop,
      updateTabStatus: noop,
      closeTabBySessionId: noop,
      reconcileTabs: noop,
    }),
  }
})

export function pane(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-chat-pane-session="${id}"]`)
  if (!node) throw new Error(`missing pane ${id}`)
  return node
}

export function emit(event: string, payload: unknown) {
  act(() => gateway.listeners.forEach((listener) => listener({ event, payload })))
}

function BackProbe() {
  const navigate = useNavigate()
  const location = useLocation()
  return <><output data-testid="route-location">{location.pathname}{location.search}</output><button type="button" onClick={() => navigate(-1)}>Test browser back</button></>
}

type RouteEntry = string | { pathname: string; search?: string; state?: unknown }

export function renderRoute(initialEntry: RouteEntry | RouteEntry[] = '/?session=a'): { unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const initialEntries = Array.isArray(initialEntry) ? initialEntry : [initialEntry]
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
        <BackProbe />
        <Routes><Route path="/" element={<ChatPageWrapper />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

export function sessionTransfer(sessionId: string): DataTransfer {
  return {
    types: [CHAT_SESSION_DND_MIME],
    files: [] as unknown as FileList,
    effectAllowed: 'copy',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: (type: string) => type === CHAT_SESSION_DND_MIME ? sessionId : '',
  } as unknown as DataTransfer
}

export { apiMocks, gateway, sessionIds }
