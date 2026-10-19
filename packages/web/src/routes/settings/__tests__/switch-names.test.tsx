import { render, screen } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

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

describe('Settings control names', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockResolvedValue({ config: {}, revision: 'rev-1' })
    apiMocks.updateConfig.mockResolvedValue({})
    apiMocks.getOrg.mockResolvedValue({ employees: [] })
    apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
    fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
  })

  it('gives every switch an accessible name, the connector and logging ones included', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )

    await screen.findByRole('switch', { name: 'Suggest fresh chats' })
    const unnamed = screen.getAllByRole('switch').filter((toggle) => !toggle.getAttribute('aria-label'))
    expect(unnamed).toHaveLength(0)
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

  it('names every select from the label of its row when it carries none of its own', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )

    await screen.findByRole('switch', { name: 'Suggest fresh chats' })
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBeGreaterThan(3)
    for (const select of selects) {
      expect(select.getAttribute('aria-label') || select.getAttribute('aria-labelledby')).toBeTruthy()
    }
    expect(screen.getByRole('combobox', { name: 'Default Engine' })).toBeTruthy()
  })
})
