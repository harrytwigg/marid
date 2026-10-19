import { render, screen } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

/* A `<select>` shows only the option it is on, never what it is for, so its only
 * name is the `ariaLabel` the call site passes. Eight settings selects shipped
 * without one and a ninth — the branding row's raw Language menu — had none
 * either, so a screen reader read bare menu options. This holds the whole page
 * to the invariant, so a new unnamed call site fails here rather than in a
 * screen reader. */

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

async function renderSettings() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
  await screen.findByRole('combobox')
}

describe('Settings selects', () => {
  it('names every select on the page, and names them apart', async () => {
    await renderSettings()

    // The `name` option asks for the computed accessible name, the same one axe
    // reads. An omitted `ariaLabel` leaves the select in `selects` but out of
    // `named`, which is the shape of the violation this page recorded nine times.
    const selects = screen.getAllByRole('combobox')
    const named = screen.queryAllByRole('combobox', { name: /./ })
    expect(named).toHaveLength(selects.length)

    // Three engines and a cron row all read "Model" or "Connector" on screen, so
    // the names must disagree — otherwise a screen reader cannot say which menu
    // it is on. Any distinct naming passes; only a collision fails.
    const names = named.map((select) => select.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(names.length)
  })

  it('labels each select with its own row, not an orphan label', async () => {
    await renderSettings()

    // FieldRow's words are a real label for the control it names: the DOM itself
    // reports the association (`labels`), and it survives a call site that
    // forgets an ariaLabel.
    const level = screen.getByRole('combobox', { name: 'Log level' })
    expect((level as HTMLSelectElement).labels?.[0]?.textContent).toBe('Level')
  })
})
