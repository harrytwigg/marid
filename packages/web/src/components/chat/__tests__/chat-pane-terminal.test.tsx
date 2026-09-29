import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'

// A terminal session renders as its shell alone: no transcript and no
// composer, whether the pane learns it from session detail or from list meta.

const live = vi.hoisted(() => ({ session: null as Record<string, unknown> | null, hydrating: false }))

vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(), sendMessage: vi.fn() } }))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => ({ data: { employees: [] } }) }))
vi.mock('@/hooks/use-features', () => ({ useFeatures: () => ({ data: { notesEnabled: false, staleChat: { enabled: false } }, isPending: false }) }))
vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => ({
    messages: [], streamingText: '', loading: false, hydrating: live.hydrating, session: live.session,
    error: null, liveContextTokens: null, backgroundActivity: null,
    reload: vi.fn(), beginSend: vi.fn(), failSend: vi.fn(), appendLocal: vi.fn(), reset: vi.fn(),
  }),
}))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => <div data-testid="messages" /> }))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))
vi.mock('@/components/chat/terminal-pane-body', () => ({
  TerminalPaneBody: ({ sessionId }: { sessionId: string }) => <div data-testid="terminal-body" data-session={sessionId} />,
}))

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(<ChatPane sessionId="s1" isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} {...props} />)
}

describe('ChatPane for a terminal session', () => {
  it('renders the shell alone — no transcript, no composer', () => {
    live.session = { id: 's1', status: 'idle', engine: 'terminal', source: 'terminal' }
    live.hydrating = false
    renderPane({ viewMode: 'chat' })
    expect(screen.getByTestId('terminal-body').getAttribute('data-session')).toBe('s1')
    expect(screen.queryByTestId('chat-input')).toBeNull()
    expect(screen.queryByTestId('messages')).toBeNull()
  })

  it('renders a terminal from list meta before the session detail has loaded', () => {
    live.session = null
    live.hydrating = true
    renderPane({ terminal: true })
    expect(screen.getByTestId('terminal-body')).toBeTruthy()
    expect(screen.queryByTestId('chat-input')).toBeNull()
  })

  it('stays a chat for any other session', () => {
    live.session = { id: 's1', status: 'idle', engine: 'claude', source: 'web' }
    live.hydrating = false
    renderPane()
    expect(screen.queryByTestId('terminal-body')).toBeNull()
    expect(screen.getByTestId('chat-input')).toBeTruthy()
  })
})
