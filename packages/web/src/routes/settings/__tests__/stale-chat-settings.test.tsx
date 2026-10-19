import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('Settings stale chat controls', () => {
  beforeEach(() => {
    apiMocks.getConfig.mockResolvedValue({ config: {
      sessions: {
        staleChat: {
          enabled: false,
          tokenThreshold: 50_000,
          staleAfterMinutes: 20,
        },
      },
    }, revision: 'rev-1' })
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

  it('writes the policy fields and disables thresholds with the toggle off', async () => {
    // The page carries a Link to /settings/plugins, so it needs a router the
    // same way any other routed surface does.
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )

    const toggle = await screen.findByRole('switch', { name: 'Suggest fresh chats' })
    const tokenThreshold = screen.getByRole('spinbutton', { name: 'Context token threshold' })
    const idleMinutes = screen.getByRole('spinbutton', { name: 'Idle minutes' })
    // The press lands on the label around the track, not on the 24px track: at
    // least 40px tall on a phone, 34px from md, and about 44px wide.
    const target = toggle.closest('[data-slot="switch-content"]')!
    expect(target.className).toContain('min-h-[40px]')
    expect(target.className).toContain('md:min-h-[34px]')
    expect(target.className).toContain('min-w-[44px]')
    expect(tokenThreshold.hasAttribute('disabled')).toBe(true)
    expect(idleMinutes.hasAttribute('disabled')).toBe(true)

    fireEvent.click(toggle)
    expect(tokenThreshold.hasAttribute('disabled')).toBe(false)
    expect(idleMinutes.hasAttribute('disabled')).toBe(false)
    fireEvent.change(tokenThreshold, { target: { value: '450000' } })
    fireEvent.change(idleMinutes, { target: { value: '90' } })

    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      sessions: {
        staleChat: {
          enabled: true,
          tokenThreshold: 450_000,
          staleAfterMinutes: 90,
        },
      },
    }), 'rev-1'))
  })
})
