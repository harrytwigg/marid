import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'

const apiMocks = vi.hoisted(() => ({
  updateSession: vi.fn(() => Promise.resolve({})),
  sendMessage: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@/lib/api', () => ({ api: apiMocks }))
// Stable references: a fresh object per render would re-trigger the pane's effects.
const orgResult = { data: { employees: [] } }
const featuresResult = { data: { notesEnabled: false, staleChat: { enabled: false } }, isPending: false }
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => orgResult }))
vi.mock('@/hooks/use-features', () => ({ useFeatures: () => featuresResult }))

const live = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => live.state }))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ sessionStatusSlot }: { sessionStatusSlot?: React.ReactNode }) => (
    <div data-testid="chat-input">{sessionStatusSlot}</div>
  ),
}))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => <div data-testid="messages" /> }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))
vi.mock('@/components/chat/session-status/session-status-cluster', () => ({
  SessionStatusCluster: (props: Record<string, unknown>) => (
    <div data-testid="cluster" data-props={JSON.stringify(props)} />
  ),
}))

function renderPane(sessionId: string | null) {
  return render(
    <ChatPane sessionId={sessionId} isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} />,
  )
}

describe('ChatPane session status cluster', () => {
  beforeEach(() => {
    live.state = {
      messages: [],
      streamingText: '',
      loading: false,
      hydrating: false,
      session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus', lastContextTokens: 42_000 },
      error: null,
      liveContextTokens: 55_000,
      backgroundActivity: null,
      reload: vi.fn(),
      beginSend: vi.fn(),
      failSend: vi.fn(),
      appendLocal: vi.fn(),
      reset: vi.fn(),
    }
    localStorage.clear()
  })

  it('gives an existing session the meter with its status and token figures', () => {
    renderPane('s1')
    const props = JSON.parse(screen.getByTestId('cluster').getAttribute('data-props') ?? '{}')
    expect(props).toEqual({
      sessionId: 's1',
      loading: false,
      status: 'idle',
      lastContextTokens: 42_000,
      liveContextTokens: 55_000,
    })
  })

  it('passes the pane turn flag so a running turn blocks the manual compact', () => {
    live.state = { ...live.state, loading: true }
    renderPane('s1')
    const props = JSON.parse(screen.getByTestId('cluster').getAttribute('data-props') ?? '{}')
    expect(props.loading).toBe(true)
  })

  it('renders no cluster in the new-chat composer', () => {
    renderPane(null)
    expect(screen.queryByTestId('cluster')).toBeNull()
  })
})
