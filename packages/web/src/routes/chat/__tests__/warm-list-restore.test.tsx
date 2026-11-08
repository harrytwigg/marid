import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'
import { settled } from './todos-tab-page-support'

// The chat list reads a shared query cache. When that cache is already warm (the reader comes back to the chat
// page from another page), the list reports its first load from its mount effect, in the same flush as the
// page's own first effects, and the page primes the newest chat from it. The open-chats list it restores is the
// real one here, so the active tab it saved can win, or lose, against that pick.
const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (id: string) => ({ id, title: `Title ${id}`, status: 'idle', engine: 'claude', messages: [] })),
  getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  getSessions: vi.fn(async () => ({ sessions: ['newest', 'saved'].map((id) => ({ id, title: `Title ${id}`, status: 'idle' })), counts: {}, perGroup: {} })),
  getPins: vi.fn(async () => ({ pins: [] })),
  getOrg: vi.fn(async () => ({ employees: [] })),
  getEngines: vi.fn(async () => ({ engines: { claude: { name: 'claude', available: true, defaultModel: 'opus', models: [], supportsPty: true } } })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  getSessionQueue: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
}))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: apiMocks }))
vi.mock('@/hooks/use-gateway', () => {
  const gateway = { events: [], connected: true, connectionSeq: 0, skillsVersion: 0, subscribe: () => () => {} }
  return { useGateway: () => gateway }
})
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
// The list as it behaves on a warm cache: it reports from its mount effect, through a transition, to the latest handler.
vi.mock('@/components/chat/chat-sidebar', async () => {
  const { startTransition, useEffect, useRef } = await import('react')
  return {
    ChatSidebar: ({ onSessionsLoaded }: { onSessionsLoaded?: (sessions: { id: string }[]) => void }) => {
      const latest = useRef(onSessionsLoaded)
      useEffect(() => { latest.current = onSessionsLoaded })
      const reported = useRef(false)
      useEffect(() => {
        if (reported.current) return
        reported.current = true
        startTransition(() => latest.current?.([{ id: 'newest' }, { id: 'saved' }]))
      })
      return <div data-testid="chat-sidebar" />
    },
    pickDeleteFallbackId: () => null,
  }
})
import ChatPageWrapper from '../page'

function RouteLocation() {
  const location = useLocation()
  return <output data-testid="route-location">{location.pathname}{location.search}</output>
}
const routeLocation = () => screen.getAllByTestId('route-location')[0].textContent
const savedTabs = () => JSON.parse(localStorage.getItem('jinn-chat-tabs') || '{}') as { tabs?: Array<{ sessionId?: string }>; activeIndex?: number }

function renderChatPage(entry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/', loader: () => null, element: <><RouteLocation /><ChatPageWrapper /></> }], { initialEntries: [entry] })
  return render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
}

describe('the chat page opened on a warm chat list', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('jinn-chat-tabs', JSON.stringify({
      tabs: [{ kind: 'session', sessionId: 'saved', label: 'saved', status: 'idle', unread: false, pinned: true }],
      activeIndex: 0,
    }))
  })
  afterEach(() => localStorage.clear())

  for (const [device, width] of [['desktop', 1280], ['phone', 390]] as const) {
    it(`restores the active tab it saved rather than the newest chat, on the ${device}`, async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
      renderChatPage('/')

      await waitFor(() => expect(routeLocation()).toBe('/?session=saved'))
      await settled()
      expect(routeLocation()).toBe('/?session=saved')
      expect(savedTabs().tabs?.map((tab) => tab.sessionId)).toEqual(['saved'])
      expect(savedTabs().activeIndex).toBe(0)
    })
  }
})
