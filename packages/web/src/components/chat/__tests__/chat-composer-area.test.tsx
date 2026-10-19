import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AREAS } from '@/contrib/types'
import { contributeProbes, describeHostedArea } from '@/contrib/__tests__/hosted-area'
import { ChatPane } from '@/components/chat/chat-pane'

/* The chat pane hosts `chat.composer`, directly above the composer.
 * Composer-adjacent rather than the message-list footer: this is mounted for
 * every view including CLI, so a contribution's visibility never depends on
 * host state a plugin cannot see. */

/* Every mocked hook hands back the SAME object on every call. A fresh literal
 * per render gives the pane's memos and effects new dependencies each pass, and
 * it re-renders until the worker runs out of memory. */
const stable = vi.hoisted(() => ({
  org: { data: { employees: [] } },
  features: {
    data: { notesEnabled: false, staleChat: { enabled: false, tokenThreshold: 300_000, staleAfterMinutes: 60 } },
    isPending: false,
  },
  liveSession: {
    messages: [],
    streamingText: '',
    loading: false,
    hydrating: false,
    session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus' },
    error: null,
    liveContextTokens: null,
    backgroundActivity: null,
    reload: () => {},
    beginSend: () => {},
    failSend: () => {},
    appendLocal: () => {},
    reset: () => {},
  },
}))

vi.mock('@/lib/api', () => ({ api: { updateSession: vi.fn(() => Promise.resolve({})) } }))

vi.mock('@/hooks/use-employees', () => ({ useOrg: () => stable.org }))

vi.mock('@/hooks/use-features', () => ({ useFeatures: () => stable.features }))

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => stable.liveSession,
  shouldRecoverStuckTurn: () => false,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}))
vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: () => <div data-testid="messages" />,
}))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))

beforeEach(() => {
  localStorage.clear()
})

async function renderChatPane() {
  render(<ChatPane sessionId="s1" isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} />)
  await screen.findByTestId('chat-input')
}

describeHostedArea('the chat pane', {
  area: AREAS.chatComposer,
  variant: 'chip',
  renderHost: renderChatPane,
  findHostContent: async () => screen.findByTestId('chat-input'),
})

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
})

it('puts a contributed chip above the composer', async () => {
  dispose = contributeProbes(AREAS.chatComposer, [{ id: 'widget' }])

  await renderChatPane()

  const contributed = screen.getByTestId('probe-widget')
  const composer = screen.getByTestId('chat-input')

  expect(contributed.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
