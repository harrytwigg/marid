import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

vi.mock('@/components/chat/chat-input', () => ({ ChatInput: () => null }))
vi.mock('@/components/chat/model-selector-row', () => ({ ModelSelectorRow: () => null }))
vi.mock('@/components/chat/chat-messages', () => ({ ChatMessages: () => null }))
vi.mock('@/components/chat/chat-employee-picker', () => ({ ChatEmployeePicker: () => null }))
vi.mock('@/components/chat/background-activity-status', () => ({ BackgroundActivityStatus: () => null }))
vi.mock('@/components/chat/cli-keybar', () => ({ CliKeybar: () => null }))
vi.mock('@/components/chat/session-status/session-status-cluster', () => ({ SessionStatusCluster: () => null }))
// The real title bar's controls, reduced to what the pane hands it.
vi.mock('@/components/chat/chat-pane-title-bar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/chat-pane-title-bar')>()),
  ChatPaneTitleBar: (props: { viewSwitchLocked?: boolean }) => <div data-testid="title-bar" data-locked={String(props.viewSwitchLocked)} />,
}))

const registry = { engines: { musecode: { supportsPty: true, ptyLockedDuringTurn: true } } } as never

function locked() {
  render(<ChatPane sessionId="s1" isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} engineRegistry={registry} multiPane onClose={() => {}} />)
  return screen.getByTestId('title-bar').getAttribute('data-locked')
}

describe('ChatPane view switch lock', () => {
  beforeEach(() => {
    live.state = {
      messages: [], streamingText: '', loading: false, turnPending: false, hydrating: false,
      session: { id: 's1', status: 'idle', engine: 'musecode', model: 'm' }, error: null, liveContextTokens: null,
      backgroundActivity: null, reload: vi.fn(), beginSend: vi.fn(), failSend: vi.fn(), appendLocal: vi.fn(), reset: vi.fn(),
    }
    localStorage.clear()
  })

  it('locks a Muse Code pane while its turn runs', () => {
    live.state = { ...live.state, loading: true }
    expect(locked()).toBe('true')
  })

  it('does not stay locked for a stopped turn that never got an answer', () => {
    live.state = { ...live.state, loading: false, turnPending: true, session: { id: 's1', status: 'interrupted', engine: 'musecode', model: 'm' } }
    expect(locked()).toBe('false')
  })
})
