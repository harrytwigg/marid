import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'
import type { GatewayEvent } from '@jinn/gateway-events'

let featuresState = {
  notesEnabled: false,
  staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
}

const apiMocks = vi.hoisted(() => ({
  updateSession: vi.fn(() => Promise.resolve({})),
  sendMessage: vi.fn(() => Promise.resolve({})),
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))

vi.mock('@/hooks/use-employees', () => ({
  useOrg: () => ({ data: { employees: [] } }),
}))

vi.mock('@/hooks/use-features', () => ({
  useFeatures: () => ({ data: featuresState, isPending: false }),
}))

const liveSessionDefaults = {
  messages: [] as unknown[],
  streamingText: '',
  loading: false,
  hydrating: false,
  session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus' } as Record<string, unknown>,
  error: null,
  liveContextTokens: null as number | null,
  backgroundActivity: null,
  reload: vi.fn(),
  beginSend: vi.fn(),
  failSend: vi.fn(),
  appendLocal: vi.fn(),
  reset: vi.fn(),
}

let liveSessionState: typeof liveSessionDefaults

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => liveSessionState,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ onSend }: { onSend: (message: string) => void }) => (
    <button type="button" onClick={() => onSend('hello')}>send message</button>
  ),
}))

vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: ({ footer }: { footer?: React.ReactNode }) => <div data-testid="messages">{footer}</div>,
}))

vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))

const paneProps = {
  sessionId: 's1',
  isActive: true,
  onFocus: () => {},
  subscribe: () => () => {},
  events: [] as GatewayEvent[],
}

/** A session at the token threshold that has been idle long enough to qualify. */
function staleSession(idleMinutes: number) {
  return {
    ...liveSessionDefaults,
    liveContextTokens: 300_000,
    session: {
      ...liveSessionDefaults.session,
      lastActivity: new Date(Date.now() - idleMinutes * 60_000).toISOString(),
    },
  }
}

async function sendAMessage() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'send message' }))
  })
}

describe('the stale-chat notice', () => {
  beforeEach(() => {
    liveSessionState = { ...liveSessionDefaults }
    featuresState = {
      notesEnabled: false,
      staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
    }
    apiMocks.sendMessage.mockClear()
    localStorage.clear()
  })

  it('never shows when the policy is disabled', () => {
    featuresState = {
      notesEnabled: false,
      staleChat: { enabled: false, tokenThreshold: 1_000, staleAfterMinutes: 1 },
    }
    liveSessionState = { ...staleSession(24 * 60), liveContextTokens: 900_000 }

    render(<ChatPane {...paneProps} />)

    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })

  it('shows only when both context and idle thresholds are met', async () => {
    liveSessionState = staleSession(61)
    const eligible = render(<ChatPane {...paneProps} />)
    expect(await screen.findByText('Start a fresh chat?')).toBeTruthy()
    eligible.unmount()

    liveSessionState = { ...staleSession(61), liveContextTokens: 299_999 }
    const idleOnly = render(<ChatPane {...paneProps} />)
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
    idleOnly.unmount()

    liveSessionState = staleSession(0)
    render(<ChatPane {...paneProps} />)
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })

  it('hands the Claude account the stale session runs on to the fresh chat, only while it is still on claude', async () => {
    const onStartFreshChat = vi.fn(() => Promise.resolve())
    const base = staleSession(61)
    liveSessionState = { ...base, session: { ...base.session, claudeProfile: { name: 'work', key: 'k' } } }
    const onClaude = render(<ChatPane {...paneProps} onStartFreshChat={onStartFreshChat} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start fresh' }))
    expect(onStartFreshChat).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', engine: 'claude', profile: 'work' }))
    onClaude.unmount()

    onStartFreshChat.mockClear()
    liveSessionState = { ...base, session: { ...base.session, engine: 'opencode', claudeProfile: { name: 'work', key: 'k' } } }
    render(<ChatPane {...paneProps} onStartFreshChat={onStartFreshChat} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start fresh' }))
    expect(onStartFreshChat).toHaveBeenCalledWith(expect.objectContaining({ engine: 'opencode', profile: undefined }))
  })

  it('keeps a dismissal across a remount of the same session', async () => {
    liveSessionState = staleSession(61)

    const first = render(<ChatPane {...paneProps} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
    expect(localStorage.getItem('jinn-stale-chat-dismissals')).toBe(JSON.stringify(['s1']))
    first.unmount()

    render(<ChatPane {...paneProps} />)
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })

  it('hides on a sent message, before the send resolves and without storing a dismissal', async () => {
    // A dismissal another session recorded earlier: a send must leave it alone.
    const otherSessionDismissals = JSON.stringify(['s0'])
    localStorage.setItem('jinn-stale-chat-dismissals', otherSessionDismissals)
    liveSessionState = staleSession(61)

    let resolveSend = () => {}
    apiMocks.sendMessage.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSend = () => resolve({}) }),
    )

    render(<ChatPane {...paneProps} />)
    expect(await screen.findByText('Start a fresh chat?')).toBeTruthy()

    await sendAMessage()

    // The request is in flight and has not come back: the notice is already gone,
    // so hiding it never waited on the network.
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
    expect(localStorage.getItem('jinn-stale-chat-dismissals')).toBe(otherSessionDismissals)

    await act(async () => { resolveSend() })

    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
    expect(localStorage.getItem('jinn-stale-chat-dismissals')).toBe(otherSessionDismissals)
  })

  it('stays hidden after the turn ends, while session activity has not moved on', async () => {
    liveSessionState = staleSession(61)

    const { rerender } = render(<ChatPane {...paneProps} />)
    expect(await screen.findByText('Start a fresh chat?')).toBeTruthy()
    await sendAMessage()

    // The turn runs and then ends before lastActivity refreshes — the window in
    // which the notice used to pop straight back.
    liveSessionState = { ...liveSessionState, loading: true }
    rerender(<ChatPane {...paneProps} />)
    liveSessionState = { ...liveSessionState, loading: false }
    rerender(<ChatPane {...paneProps} />)

    expect(screen.queryByText('Start a fresh chat?')).toBeNull()
  })

  it('comes back once activity moves forward and the session is stale again', async () => {
    liveSessionState = staleSession(200)

    const { rerender } = render(<ChatPane {...paneProps} />)
    expect(await screen.findByText('Start a fresh chat?')).toBeTruthy()
    await sendAMessage()
    expect(screen.queryByText('Start a fresh chat?')).toBeNull()

    liveSessionState = staleSession(61)
    rerender(<ChatPane {...paneProps} />)

    expect(await screen.findByText('Start a fresh chat?')).toBeTruthy()
  })
})
