import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'
import { PaneTabsContext, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'

vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(() => Promise.resolve({})), sendMessage: vi.fn(() => Promise.resolve({})) } }))
vi.mock('@/hooks/use-employees', () => ({ useOrg: () => stable.org }))
vi.mock('@/hooks/use-features', () => ({ useFeatures: () => stable.features }))
// Stable objects, as the real hooks return between updates: a fresh one per render re-fires effects.
const stable = vi.hoisted(() => ({
  org: { data: { employees: [] } },
  features: { data: { notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 0, staleAfterMinutes: 0 } }, isPending: false },
  live: {
    messages: [], streamingText: '', loading: false, hydrating: false, error: null, liveContextTokens: null, backgroundActivity: null,
    session: { id: 's1', title: 'Release check', status: 'idle', engine: 'claude', model: 'opus' },
    reload: () => undefined, beginSend: () => undefined, failSend: () => undefined, appendLocal: () => undefined, reset: () => undefined,
  },
}))
vi.mock('@/hooks/use-live-session', () => ({ useLiveSession: () => stable.live }))
vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => <div data-testid="chat-input" /> }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => <div data-testid="messages" /> }))
vi.mock('@/components/chat/file-view', () => ({
  FileView: ({ path, sessionId }: { path: string; sessionId?: string | null }) => <div data-testid="file-view">{path}@{sessionId}</div>,
}))

function binding(overrides: Partial<PaneTabsBinding> = {}): PaneTabsBinding {
  return {
    renderStrip: () => null,
    hasStrips: true,
    keep: () => undefined,
    closable: () => true,
    shownDoc: (tabId) => (tabId === 's1' ? { kind: 'file', file: { path: 'docs/report.md', sessionId: 's1' } } : null),
    ...overrides,
  }
}

function pane(value: PaneTabsBinding, props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return (
    <PaneTabsContext.Provider value={value}>
      <ChatPane sessionId="s1" isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} multiPane onClose={vi.fn()} {...props} />
    </PaneTabsContext.Provider>
  )
}

describe('ChatPane with a file tab shown', () => {
  it('covers the chat below the title bar, keeping the chat mounted but inert', async () => {
    const { container } = render(pane(binding()))
    expect((await screen.findByTestId('file-view')).textContent).toBe('docs/report.md@s1')
    expect(screen.getByTestId('chat-pane-title-bar')).toBeTruthy()
    expect(screen.getByTestId('messages')).toBeTruthy()
    expect(container.querySelector('[data-chat-pane-body]')!.hasAttribute('inert')).toBe(true)
    // In flow under the title bar: the file view and the chat share one region, not a measured offset.
    expect(screen.getByTestId('pane-file-view').parentElement).toBe(container.querySelector('[data-chat-pane-body]')!.parentElement)
  })

  it('shows the chat where there is no title bar (a phone) to switch back with', () => {
    const { container } = render(pane(binding(), { multiPane: false }))
    expect(screen.queryByTestId('pane-file-view')).toBeNull()
    expect(container.querySelector('[data-chat-pane-body]')!.hasAttribute('inert')).toBe(false)
  })

  it('offers no close button for the only chat on screen', () => {
    const { rerender } = render(pane(binding()))
    expect(screen.getByRole('button', { name: 'Close Release check' })).toBeTruthy()
    rerender(pane(binding({ closable: () => false })))
    expect(screen.queryByRole('button', { name: 'Close Release check' })).toBeNull()
    expect(screen.getByTestId('chat-pane-title-bar')).toBeTruthy()
  })
})
