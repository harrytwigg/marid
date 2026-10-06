/**
 * The held transcript survives a destination saved in CLI view.
 *
 * The pane runs one step behind the URL, so everything that decides what the
 * pane RENDERS has to run one step behind it too. View mode is the one that
 * bites: it is stored per session, and while a switch held the outgoing chat on
 * screen it was already reading the incoming session's mode — so a destination
 * saved as CLI swapped the transcript for a blank terminal surface before the
 * destination had even been committed.
 *
 * The real route and the real pane, with only the transport mocked: a stub of
 * either would stay green with the fix reverted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

const HELD = [{ id: 'a-m1', role: 'user', content: 'the message being read', timestamp: 1_000 }]

const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(async () => ({ messages: [], hasOlder: false })),
  getSessions: vi.fn(async () => ({ sessions: [], counts: {}, perGroup: {} })),
  getOrg: vi.fn(async () => ({ employees: [] })),
  // supportsPty is what makes the CLI view reachable at all — without it the
  // route pins the pane to chat and the defect cannot reproduce.
  getEngines: vi.fn(async () => ({
    default: 'claude',
    engines: {
      claude: {
        name: 'claude',
        available: true,
        defaultModel: 'opus',
        effortMechanism: 'claude-flag',
        models: [{ id: 'opus', label: 'Opus', supportsEffort: false, effortLevels: [] }],
        supportsPty: true,
      },
    },
  })),
  getFeatures: vi.fn(async () => ({ notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300000, staleAfterMinutes: 60 } })),
  getSkills: vi.fn(async () => []),
  getSessionQueue: vi.fn(async () => []),
  sendMessage: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: apiMocks }
})

vi.mock('@/hooks/use-gateway', async () => {
  const subscribe = () => () => {}
  const gateway = { events: [], connected: true, connectionSeq: 0, skillsVersion: 0, subscribe }
  return { useGateway: () => gateway }
})

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/chat/chat-sidebar', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
  pickDeleteFallbackId: () => null,
}))

// Both chats are already open as tabs, the way they are once you have visited
// them, and the active one follows the URL. Left to hydrate from storage, the
// route's tab reconciler decides the URL names a session it has no tab for and
// bounces it to a blank composer — a different story than the one under test.
vi.mock('@/hooks/use-chat-tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-tabs')>()
  const { useCallback, useState } = await import('react')
  const tabs = [
    { kind: 'session', sessionId: 'a', label: 'A', status: 'idle', unread: false },
    { kind: 'session', sessionId: 'b', label: 'B', status: 'idle', unread: false },
  ] as const
  const noop = () => {}
  return {
    ...actual,
    useChatTabs: () => {
      const [activeIndex, setActiveIndex] = useState(0)
      const openTab = useCallback((incoming: { sessionId: string }) => {
        setActiveIndex(tabs.findIndex((tab) => tab.sessionId === incoming.sessionId))
      }, [])
      return {
        tabs,
        activeTab: tabs[activeIndex],
        activeIndex,
        hydrated: true,
        openTab,
        openDocTab: noop,
        closeTab: noop,
        switchTab: setActiveIndex,
        nextTab: noop,
        prevTab: noop,
        pinTab: noop,
        moveTab: noop,
        clearActiveTab: noop,
        updateTabStatus: noop,
        closeTabBySessionId: noop,
        reconcileTabs: noop,
      }
    },
  }
})

import ChatPageWrapper from '../page'

let navigate: ReturnType<typeof useNavigate>

function RouterProbe() {
  navigate = useNavigate()
  return null
}

function renderChatRoute() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/?session=a']}>
        <RouterProbe />
        <Routes>
          <Route path="/" element={<ChatPageWrapper />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const transcript = () => document.querySelector('.chat-messages-scroll')

async function settle(ms: number) {
  for (let remaining = ms; remaining > 0; remaining -= 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(50, remaining)) })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorage.setItem('jinn-view-mode-a', 'chat')
  localStorage.setItem('jinn-view-mode-b', 'cli')
  apiMocks.getSession.mockReset()
  apiMocks.getSession.mockImplementation((id: string) => (
    id === 'a'
      ? Promise.resolve({ id, status: 'idle', engine: 'claude', model: 'opus', messages: HELD })
      : new Promise(() => {})
  ))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('switching to a chat saved in CLI view', () => {
  it('keeps the held transcript mounted while the destination is still being fetched', async () => {
    renderChatRoute()
    await settle(200)
    const held = transcript()
    expect(held).not.toBeNull()

    await act(async () => { await navigate('/?session=b') })
    await settle(600)

    expect(held?.isConnected).toBe(true)
    expect(document.querySelector('[role="status"][aria-label="Loading chat"]')).toBeNull()
  })
})

