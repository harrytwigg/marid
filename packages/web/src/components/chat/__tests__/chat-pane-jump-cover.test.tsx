import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'
import { PaneTabsContext, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'

vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(() => Promise.resolve({})), sendMessage: vi.fn(() => Promise.resolve({})) } }))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => stable.org }))
vi.mock('@/hooks/use-features', () => ({ useFeatures: () => stable.features }))
const stable = vi.hoisted(() => ({
  org: { data: { employees: [] } },
  features: { data: { notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 0, staleAfterMinutes: 0 } }, isPending: false },
  live: {
    messages: [{ id: 'm1', role: 'assistant', content: 'Latest answer', timestamp: 100 }],
    streamingText: '', loading: false, hydrating: false, error: null, liveContextTokens: null, backgroundActivity: null,
    session: { id: 's1', title: 'Release check', status: 'idle', engine: 'claude', model: 'opus' },
    reload: () => undefined, beginSend: () => undefined, failSend: () => undefined, appendLocal: () => undefined, reset: () => undefined,
  },
}))
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => stable.live }))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
// A transcript scrolled away from its bottom with 7 new messages below, whatever the pane around it does.
vi.mock('@/hooks/use-stick-to-bottom', () => ({
  useStickToBottom: () => ({ containerRef: vi.fn(), showJump: true, unreadCount: 7, scrollToBottom: vi.fn() }),
}))
vi.mock('@/components/chat/file-view', () => ({ FileView: () => <div data-testid="file-view" /> }))
vi.mock('@/components/chat/doc-view', () => ({ DocView: () => <div data-testid="doc-view" /> }))

function binding(shownDoc: PaneTabsBinding['shownDoc']): PaneTabsBinding {
  return { renderStrip: () => null, hasStrips: true, keep: () => undefined, closable: () => true, shownDoc }
}

function pane(value: PaneTabsBinding, props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return (
    <PaneTabsContext.Provider value={value}>
      <ChatPane sessionId="s1" isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} multiPane onClose={vi.fn()} {...props} />
    </PaneTabsContext.Provider>
  )
}

const JUMP = { name: /jump to latest/i }

describe('ChatPane jump-to-latest next to a document tab', () => {
  it('offers the jump, with its count, while the chat itself is shown', () => {
    render(pane(binding(() => null)))
    expect(screen.getByRole('button', JUMP).getAttribute('aria-label')).toBe('Jump to latest, 7 new messages')
  })

  it('offers none while the Todos tab is shown over the chat', () => {
    render(pane(binding(() => ({ kind: 'todos' }))))
    expect(screen.getByTestId('doc-view')).toBeTruthy()
    expect(screen.queryByRole('button', JUMP)).toBeNull()
  })

  it('offers none while a file tab is shown over the chat', () => {
    render(pane(binding(() => ({ kind: 'file', file: { path: 'docs/report.md', sessionId: 's1' } }))))
    expect(screen.queryByRole('button', JUMP)).toBeNull()
  })

  it('keeps what floats over the transcript in the chat body\'s own stacking context, below the document', () => {
    const { container } = render(pane(binding(() => ({ kind: 'todos' }))))
    const body = container.querySelector<HTMLElement>('[data-chat-pane-body]')!
    expect(body.style.isolation).toBe('isolate')
  })

  it('shows the chat and its jump on a phone, which has no strip to switch back with', () => {
    render(pane(binding(() => ({ kind: 'todos' })), { multiPane: false }))
    expect(screen.getByRole('button', JUMP)).toBeTruthy()
  })
})
