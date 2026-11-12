import { fireEvent, render, screen, within } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import SettingsPage from '../../page'


const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))
const fetchTalkCapability = vi.hoisted(() => vi.fn())
const registry = vi.hoisted(() => ({ current: undefined as unknown }))
const chains = vi.hoisted(() => ({ current: undefined as unknown }))

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
vi.mock('@/hooks/use-model-registry', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/use-model-registry')>()),
  useModelRegistry: () => ({ data: registry.current }),
}))
vi.mock('@/hooks/use-fallback-chains', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/use-fallback-chains')>()),
  useFallbackChains: () => ({ data: chains.current }),
}))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

const limits = vi.hoisted(() => ({ current: undefined as unknown, calls: 0 }))
vi.mock('@/routes/limits/use-engine-limits', () => ({
  useEngineLimits: () => { limits.calls += 1; return { data: limits.current } },
}))

const model = (id: string, label = id, extra: Record<string, unknown> = {}) => ({ id, label, supportsEffort: false, effortLevels: [], ...extra })
const engine = (name: string, models = [model('x/one')]) => ({ name, available: true, defaultModel: models[0].id, effortMechanism: 'none', models })

async function renderSettings() {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByRole('switch', { name: 'Interrupt on new message' })
}

beforeEach(() => {
  vi.clearAllMocks()
  limits.calls = 0
  chains.current = undefined
  registry.current = { default: 'claude', engines: { claude: engine('claude'), opencode: engine('opencode') } }
  apiMocks.updateConfig.mockResolvedValue({})
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
  limits.current = {
    generatedAt: new Date().toISOString(), default: 'claude', engines: {},
    accounts: { opencode: [
      { account: 'go-b', label: 'Go (second)', provider: 'opencode-go-b', base: 'opencode-go', keyEnv: 'OPENCODE_GO_B_API_KEY', keySet: false,
        problems: ['account "go-b" has no key: OPENCODE_GO_B_API_KEY is not set'] },
      { account: 'go-a', label: 'go-a', provider: 'opencode-go' },
    ] },
  }
})

describe('opencode accounts list', () => {
  it('lists each declared account with provider, base, key state, models, limits and problems', async () => {
    apiMocks.getConfig.mockResolvedValue({ revision: 'r', config: { engines: { opencode: { accounts: {
      'go-b': { provider: 'opencode-go-b', base: 'opencode-go', keyEnv: 'OPENCODE_GO_B_API_KEY', label: 'Go (second)',
        models: ['deepseek-v4.1-flash', 'mimo-v2.6-pro'], usageLimits: { monthlyUsd: { '*': 100, 'mimo-v2.6-pro': 15 } } },
      'go-a': { provider: 'opencode-go' },
    } } } } })
    await renderSettings()

    const b = document.querySelector('[data-opencode-account="go-b"]') as HTMLElement
    expect(within(b).getByText('Go (second)')).toBeTruthy()
    expect(b.textContent).toContain('opencode-go-b')
    expect(b.textContent).toContain('opencode-go')
    expect(within(b).getByTestId('key-var').textContent).toBe('OPENCODE_GO_B_API_KEY · not set')
    expect(b.textContent).toContain('2: deepseek-v4.1-flash, mimo-v2.6-pro')
    expect(b.textContent).toContain('all models $100/mo, mimo-v2.6-pro $15/mo')
    expect(within(b).getByTestId('account-problem').textContent).toContain('OPENCODE_GO_B_API_KEY is not set')

    const a = document.querySelector('[data-opencode-account="go-a"]') as HTMLElement
    expect(a.textContent).toContain('built-in')
    expect(a.textContent).toContain('all')
    expect(within(a).queryByTestId('key-var')).toBeNull()
    expect(document.querySelector('[data-engine-card="opencode"]')!.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a set key as set', async () => {
    limits.current = { generatedAt: '', default: 'claude', engines: {}, accounts: { opencode: [{ account: 'go-b', label: 'go-b', provider: 'p', base: 'b', keyEnv: 'K', keySet: true }] } }
    apiMocks.getConfig.mockResolvedValue({ revision: 'r', config: { engines: { opencode: { accounts: { 'go-b': { provider: 'p', base: 'b', keyEnv: 'K' } } } } } })
    await renderSettings()
    expect(screen.getByTestId('key-var').textContent).toBe('K · set')
  })

  it('adds nothing, and never asks for limits, with no accounts declared', async () => {
    apiMocks.getConfig.mockResolvedValue({ revision: 'r', config: { engines: { opencode: {} } } })
    await renderSettings()
    expect(screen.queryByTestId('opencode-accounts')).toBeNull()
    expect(document.querySelector('[data-opencode-account]')).toBeNull()
    expect(limits.calls).toBe(0)
  })

  it('gives the chain editor each account\'s label, from the config it is editing', async () => {
    registry.current = {
      default: 'claude',
      engines: {
        claude: engine('claude'),
        opencode: engine('opencode', [model('opencode-go/a', 'Alpha', { account: 'go-a' }), model('opencode-go-b/a', 'Alpha', { account: 'go-b' })]),
      },
    }
    apiMocks.getConfig.mockResolvedValue({ revision: 'r', config: { engines: {
      claude: { fallback: [{ engine: 'opencode' }] },
      opencode: { accounts: { 'go-a': { provider: 'opencode-go' }, 'go-b': { provider: 'opencode-go-b', base: 'opencode-go', keyEnv: 'K', label: 'Go (second workspace)' } } },
    } } })
    await renderSettings()

    fireEvent.keyDown(screen.getByRole('button', { name: /Model of link 1 of the Claude chain/ }), { key: 'Enter' })
    expect(Array.from(document.querySelectorAll('[data-account-badge]')).map((b) => b.textContent)).toEqual(['go-a', 'Go (second workspace)'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'second' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
  })
})
