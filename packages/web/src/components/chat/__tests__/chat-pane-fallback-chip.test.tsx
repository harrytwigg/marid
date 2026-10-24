import '@/test/preload-menus'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'
import type { SessionFallbackView } from '../fallback-mode-model'

/** The fallback chip on the new-chat screen, and while a turn runs. */

const apiMocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getFallbackPreview: vi.fn(),
  sendMessage: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const orgResult = vi.hoisted(() => ({ data: { employees: [{ name: 'platform-lead', displayName: 'Platform Lead' }] } }))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => orgResult }))
vi.mock('@/hooks/use-features', () => ({
  useFeatures: () => ({ data: { notesEnabled: false, staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 } }, isPending: false }),
}))

let liveSessionState: Record<string, unknown>
let composerOnSend: ((message: string) => Promise<boolean>) | null = null
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => liveSessionState }))
vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot, onSend }: { selectorSlot?: React.ReactNode; onSend: (message: string) => Promise<boolean> }) => {
    composerOnSend = onSend
    return <div data-testid="chat-input">{selectorSlot}</div>
  },
}))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => <div data-testid="messages" /> }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
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

const preview: SessionFallbackView = {
  mode: 'fallback', modeSource: 'default', targetSource: 'config', allowedEngines: ['claude', 'codex'],
  target: { engine: 'codex', model: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
}

beforeEach(() => {
  localStorage.clear()
  composerOnSend = null
  Object.values(apiMocks).forEach((m) => m.mockReset())
  apiMocks.getFallbackPreview.mockResolvedValue({ fallback: preview })
  apiMocks.updateSession.mockResolvedValue({})
  apiMocks.sendMessage.mockResolvedValue({})
  apiMocks.createSession.mockResolvedValue({ id: 'new-session' })
  liveSessionState = {
    messages: [], streamingText: '', loading: false, hydrating: false, session: null, error: null,
    liveContextTokens: null, backgroundActivity: null, reload: vi.fn(), beginSend: vi.fn(), failSend: vi.fn(),
    appendLocal: vi.fn(), reset: vi.fn(),
  }
})

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(<ChatPane sessionId={null} isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} {...props} />)
}
const chip = () => screen.getByTestId('fallback-mode-chip') as HTMLButtonElement
const openMenu = () => fireEvent.keyDown(chip(), { key: 'Enter' })

describe('the new-chat screen', () => {
  it('shows the chip with the mode and fallback model a new session would start with', async () => {
    renderPane()
    expect(await screen.findByTestId('fallback-mode-chip')).toBeTruthy()
    expect(chip().textContent).toContain('Fallback: gpt-5.6-sol')
    expect(apiMocks.getFallbackPreview).toHaveBeenCalled()
  })

  it('sends the mode picked there with the create request, and nothing it was not asked for', async () => {
    renderPane()
    await screen.findByTestId('fallback-mode-chip')
    openMenu()
    await act(async () => { fireEvent.click(await screen.findByRole('menuitemradio', { name: /auto-resume/i })) })
    await waitFor(() => expect(chip().textContent).toContain('off (auto-resume)'))
    // Nothing is sent to a session: there is none yet.
    expect(apiMocks.updateSession).not.toHaveBeenCalled()

    await act(async () => { await composerOnSend?.('hello') })
    expect(apiMocks.createSession).toHaveBeenCalledOnce()
    expect(apiMocks.createSession.mock.calls[0][0]).toMatchObject({ prompt: 'hello', fallbackMode: 'auto-resume' })
    expect(apiMocks.createSession.mock.calls[0][0]).not.toHaveProperty('fallbackTarget')
  })

  it('leaves both fields out when the operator chose nothing, so the session follows the config', async () => {
    renderPane()
    await screen.findByTestId('fallback-mode-chip')
    await act(async () => { await composerOnSend?.('hello') })
    const params = apiMocks.createSession.mock.calls[0][0]
    expect(params).not.toHaveProperty('fallbackMode')
    expect(params).not.toHaveProperty('fallbackTarget')
  })

  it('shows no chip against a gateway without the preview route, and still creates the session', async () => {
    apiMocks.getFallbackPreview.mockRejectedValue(new Error('not found'))
    renderPane()
    await act(async () => { await composerOnSend?.('hello') })
    expect(screen.queryByTestId('fallback-mode-chip')).toBeNull()
    expect(apiMocks.createSession).toHaveBeenCalledOnce()
  })
})

describe('a running turn', () => {
  it('leaves the chip enabled, and a change made mid-turn is saved to the session', async () => {
    liveSessionState = { ...liveSessionState, loading: true, session: { id: 's1', status: 'running', engine: 'claude', model: 'opus', fallback: preview } }
    renderPane({ sessionId: 's1' })
    expect(chip().disabled).toBe(false)

    openMenu()
    await act(async () => { fireEvent.click(await screen.findByRole('menuitemradio', { name: /auto-resume/i })) })
    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', { fallbackMode: 'auto-resume' })
    await waitFor(() => expect(chip().textContent).toContain('off (auto-resume)'))
  })
})
