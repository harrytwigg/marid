import '@/test/preload-menus'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import type { EnginesResponse } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPane } from '../chat-pane'

/** The new-chat pane sends, and previews, only a Claude profile it has confirmed. */

const apiMocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getFallbackPreview: vi.fn(),
  sendMessage: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const orgResult = vi.hoisted(() => ({
  data: { employees: [{ name: 'remote-lead', displayName: 'Remote Lead', remoteHost: 'box-2' }] },
}))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => orgResult }))
vi.mock('@/hooks/use-features', () => ({
  useFeatures: () => ({ data: { notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 1, staleAfterMinutes: 1 } }, isPending: false }),
}))

// `null` = the chains read has not loaded or failed (data undefined).
const declared: { current: string[] | null } = { current: ['work'] }
vi.mock('@/hooks/use-fallback-chains', () => ({
  useFallbackChains: () => ({
    data: declared.current
      ? { profiles: declared.current.map((name) => ({ name, account: name, configDir: `/x/${name}` })), subjects: [] }
      : undefined,
  }),
}))

let liveSessionState: Record<string, unknown>
let composerOnSend: ((message: string) => Promise<boolean>) | null = null
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => liveSessionState }))
const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'none',
      models: [{ id: 'opus', label: 'Opus', supportsEffort: false, effortLevels: [] }],
    },
    opencode: {
      name: 'opencode', available: true, defaultModel: 'x', effortMechanism: 'none',
      models: [{ id: 'x', label: 'X', supportsEffort: false, effortLevels: [] }],
    },
  },
}
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})
vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot, onSend }: { selectorSlot?: React.ReactNode; onSend: (message: string) => Promise<boolean> }) => {
    composerOnSend = onSend
    return <div data-testid="chat-input">{selectorSlot}</div>
  },
}))
vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: ({ emptyState }: { emptyState?: React.ReactNode }) => <div data-testid="messages">{emptyState}</div>,
}))
vi.mock('@/components/chat/chat-employee-picker', () => ({
  ChatEmployeePicker: ({ onSelect }: { onSelect: (name: string | null) => void }) => (
    <button type="button" onClick={() => onSelect('remote-lead')}>pick remote employee</button>
  ),
}))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({ matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList
  }
})

const SELECTOR_KEY = 'jinn-chat-new-session-selector'
const remember = (profile: string) => localStorage.setItem(SELECTOR_KEY, JSON.stringify({ engine: 'claude', model: 'opus', profile }))
const remembered = () => JSON.parse(localStorage.getItem(SELECTOR_KEY) ?? '{}') as { profile?: string }

beforeEach(() => {
  localStorage.clear()
  declared.current = ['work']
  composerOnSend = null
  Object.values(apiMocks).forEach((m) => m.mockReset())
  apiMocks.getFallbackPreview.mockResolvedValue({ fallback: null })
  apiMocks.createSession.mockResolvedValue({ id: 'new-session' })
  liveSessionState = {
    messages: [], streamingText: '', loading: false, hydrating: false, session: null, error: null,
    liveContextTokens: null, backgroundActivity: null, reload: vi.fn(), beginSend: vi.fn(), failSend: vi.fn(),
    appendLocal: vi.fn(), reset: vi.fn(),
  }
})

function renderPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ChatPane sessionId={null} isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} />
    </QueryClientProvider>,
  )
}
const send = () => act(async () => { await composerOnSend?.('hello') })
const sentEngine = () => (apiMocks.createSession.mock.calls[0][0] as { engine?: string }).engine
const previewedEngines = () => apiMocks.getFallbackPreview.mock.calls.map((c) => (c[0] as { engine?: string }).engine)

describe('the new-chat pane and the Claude profile', () => {
  it('sends the remembered declared profile with the create request and previews its chain', async () => {
    remember('work')
    renderPane()
    await waitFor(() => expect(previewedEngines()).toContain('claude:work'))
    await send()
    expect(sentEngine()).toBe('claude:work')
  })

  it('sends the bare engine while the chains read has not confirmed the profile, and previews it too', async () => {
    declared.current = null
    remember('work')
    renderPane()
    await waitFor(() => expect(apiMocks.getFallbackPreview).toHaveBeenCalled())
    expect(previewedEngines()).not.toContain('claude:work')
    await send()
    expect(sentEngine()).toBe('claude')
  })

  it('sends the bare engine for a profile that is no longer declared, without erasing the remembered choice', async () => {
    remember('gone')
    renderPane()
    await waitFor(() => expect(apiMocks.getFallbackPreview).toHaveBeenCalled())
    await send()
    expect(sentEngine()).toBe('claude')
    expect(remembered().profile).toBe('gone')
  })

  it('sends the bare engine once a remote employee is picked, and keeps the remembered profile for later', async () => {
    renderPane()
    // A deliberate pick in the selector marks the composer as hand-edited, so the employee does not reset it.
    fireEvent.keyDown(await screen.findByRole('button', { name: /model and effort/i }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /claude · work/i }))
    expect(remembered().profile).toBe('work')

    fireEvent.click(screen.getByRole('button', { name: 'pick remote employee' }))
    await send()
    expect(apiMocks.createSession.mock.calls[0][0]).toMatchObject({ employee: 'remote-lead', engine: 'claude' })
    expect(remembered().profile).toBe('work')
  })
})
