import { render, screen } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

/* A `role="switch"` control is an input with no text of its own, so its only
 * name is the `ariaLabel` the call site passes. Five switches shipped without
 * one and a screen reader announced each as a bare "switch" (MAR-101). This
 * holds the whole page to the invariant, so a new unnamed call site fails here
 * rather than in a screen reader. */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))

const fetchTalkCapability = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/lib/talk-capability', () => ({ fetchTalkCapability }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: {},
    setAccentColor: vi.fn(),
    setCompanyName: vi.fn(),
    setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(),
    setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(),
    resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({
    authState: {},
    devices: [],
    createPairingCode: vi.fn(),
    logout: vi.fn(),
    unpairDevice: vi.fn(),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  apiMocks.getConfig.mockResolvedValue({ config: {}, revision: 'rev-1' })
  apiMocks.updateConfig.mockResolvedValue({})
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({
    available: false,
    model: null,
    downloading: false,
    progress: 0,
    languages: ['en'],
  })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
})

describe('Settings switches', () => {
  it('names every switch on the page', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )
    await screen.findByRole('switch', { name: 'Suggest fresh chats' })

    // The `name` option asks for the computed accessible name, the same one axe
    // reads. An omitted `ariaLabel` leaves the switch in `switches` but out of
    // `named`, which is the shape of the violation MAR-101 recorded five times.
    const switches = screen.getAllByRole('switch')
    const named = screen.queryAllByRole('switch', { name: /./ })
    expect(named).toHaveLength(switches.length)

    // The five that shipped unnamed: named now, and after their visible row
    // rather than a generic "switch".
    for (const name of [
      'Share Slack session in channel',
      'Ignore old Slack messages on boot',
      'Ignore old Telegram messages on boot',
      'Log to stdout',
      'Log to file',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeTruthy()
    }
  })
})
