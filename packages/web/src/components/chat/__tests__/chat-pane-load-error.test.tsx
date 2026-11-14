import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatPane } from '../chat-pane'

// What the pane says when its conversation could not be fetched, instead of a blank transcript.
const apiMocks = vi.hoisted(() => ({
  updateSession: vi.fn(() => Promise.resolve({})),
  sendMessage: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@/lib/api', () => ({ api: apiMocks }))
const orgResult = { data: { employees: [] } }
const featuresResult = { data: { notesEnabled: false, staleChat: { enabled: false } }, isPending: false }
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => orgResult }))
vi.mock('@/hooks/use-features', () => ({ useFeatures: () => featuresResult }))

const live = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => live.state }))

vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => <div data-testid="messages" /> }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))
vi.mock('@/components/chat/session-status/session-status-cluster', () => ({ SessionStatusCluster: () => null }))

const reload = vi.fn()

function renderPane(sessionId: string | null) {
  return render(<ChatPane sessionId={sessionId} isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} />)
}

describe('ChatPane when the conversation could not be loaded', () => {
  beforeEach(() => {
    reload.mockReset()
    live.state = {
      messages: [], streamingText: '', loading: false, hydrating: false,
      session: null, error: null, loadRetrying: false,
      liveContextTokens: null, backgroundActivity: null,
      reload, beginSend: vi.fn(), failSend: vi.fn(), appendLocal: vi.fn(), reset: vi.fn(),
    }
    localStorage.clear()
  })

  it('shows nothing when the load worked', () => {
    renderPane('s1')
    expect(screen.queryByTestId('session-load-notice')).toBeNull()
  })

  it('says the load failed and is being retried, and "Retry now" fetches the session again', () => {
    live.state = { ...live.state, error: new TypeError('Failed to fetch'), loadRetrying: true }
    renderPane('s1')
    expect(screen.getByTestId('session-load-notice').textContent).toContain("Couldn't refresh this conversation. Retrying.")
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(reload).toHaveBeenCalledWith('s1')
  })

  it('does not claim a retry for a failure the hook will not retry', () => {
    live.state = { ...live.state, error: new Error('not found'), loadRetrying: false }
    renderPane('s1')
    const text = screen.getByTestId('session-load-notice').textContent ?? ''
    expect(text).toContain("Couldn't load this conversation.")
    expect(text).not.toContain('Retrying')
  })

  it('shows no notice on a blank new chat', () => {
    live.state = { ...live.state, error: new Error('x'), loadRetrying: true }
    renderPane(null)
    expect(screen.queryByTestId('session-load-notice')).toBeNull()
  })
})
