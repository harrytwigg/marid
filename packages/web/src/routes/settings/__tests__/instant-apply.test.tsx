import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'
import { CONFIG_COMMIT_DEBOUNCE_MS } from '../use-config-commit'

/* Settings has no Save button. Every edit has to write itself — once, promptly,
 * and visibly enough that a refused write is never mistaken for a saved one.
 * `Interrupt on New Message` is the toggle that used to revert on reload. */

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
    setAccentColor: vi.fn(), setCompanyName: vi.fn(), setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(), setOperatorName: vi.fn(), setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(), resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

const INTERRUPT = { name: 'Interrupt on new message' }

function served(config: Record<string, unknown>) {
  apiMocks.getConfig.mockResolvedValue({ config, revision: 'rev-1' })
}

async function renderSettings() {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  return screen.findByRole('switch', INTERRUPT)
}

/** Long enough that a second write, if the page had one queued, would have gone. */
function afterTheWindow() {
  return new Promise((resolve) => setTimeout(resolve, CONFIG_COMMIT_DEBOUNCE_MS + 200))
}

beforeEach(() => {
  vi.clearAllMocks()
  served({ logging: { level: 'info' }, sessions: { interruptOnNewMessage: true } })
  apiMocks.updateConfig.mockResolvedValue({ revision: 'rev-2' })
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
})

describe('a setting turned off', () => {
  it('writes the false on its own, carrying the revision it was read with', async () => {
    fireEvent.click(await renderSettings())

    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1))
    const [document, revision] = apiMocks.updateConfig.mock.calls[0]
    expect((document as any).sessions.interruptOnNewMessage).toBe(false)
    expect(revision).toBe('rev-1')
  })

  it('reads a stored false back as off, rather than falling through to the default', async () => {
    served({ sessions: { interruptOnNewMessage: false } })

    expect((await renderSettings()).getAttribute('aria-checked')).toBe('false')
  })
})

describe('one edit, one write', () => {
  it('writes a toggle once, as soon as the debounce window closes', async () => {
    const toggle = await renderSettings()

    // The page is up; from here the clock is ours, so the bound is the code's
    // own debounce rather than how fast this host happens to be.
    vi.useFakeTimers()
    try {
      fireEvent.click(toggle)

      await vi.advanceTimersByTimeAsync(CONFIG_COMMIT_DEBOUNCE_MS - 1)
      expect(apiMocks.updateConfig).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(CONFIG_COMMIT_DEBOUNCE_MS * 2)
      expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes ten keystrokes once, not once each', async () => {
    await renderSettings()
    const host = screen.getByPlaceholderText('127.0.0.1')

    const typed = '10.0.0.42'
    for (let i = 1; i <= typed.length; i++) {
      fireEvent.change(host, { target: { value: typed.slice(0, i) } })
    }

    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1))
    await afterTheWindow()
    expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1)
    expect((apiMocks.updateConfig.mock.calls[0][0] as any).gateway.host).toBe(typed)
  })
})

describe('what the page says about the write', () => {
  it('says saving, then saved', async () => {
    let land: (result: { revision: string }) => void = () => {}
    apiMocks.updateConfig.mockReturnValue(new Promise((resolve) => { land = resolve }))

    fireEvent.click(await renderSettings())

    expect(await screen.findByText('Saving…')).toBeTruthy()
    land({ revision: 'rev-2' })
    expect(await screen.findByText('Saved')).toBeTruthy()
  })

  it('says what the gateway said when the write is refused, and never says saved', async () => {
    apiMocks.updateConfig.mockRejectedValue(new Error('Unknown config keys: remotes'))

    fireEvent.click(await renderSettings())

    expect(await screen.findByText('Failed to save: Unknown config keys: remotes')).toBeTruthy()
    expect(screen.queryByText('Saved')).toBeNull()
  })
})
