import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import SettingsPage from '../../page'

/* A chain already stored with a duplicate, on the Engine Fallbacks section, in the same harness as
 * engines-section.test.tsx. Chains are edited into the
 * page's config state and land on the wire through the page's own write path
 * button, so every assertion here is about what `api.updateConfig` receives. */

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

/** Six days out: the case a bare clock time used to render as this afternoon. */
const EXHAUSTED_UNTIL = new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString()

const model = (id: string, label = id) => ({ id, label, supportsEffort: false, effortLevels: [] })

function engine(name: string, available: boolean, defaultModel: string, extra: Record<string, unknown> = {}) {
  return { name, available, defaultModel, effortMechanism: 'none', models: [model(defaultModel)], ...extra }
}

async function renderSettings() {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByRole('switch', { name: 'Interrupt on new message' })
}


/** Settings save themselves; what a test waits for is the write. */
async function save() {
  await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalled())
  return apiMocks.updateConfig.mock.calls[0][0] as Record<string, any>
}

function loadConfig(config: Record<string, unknown>) {
  apiMocks.getConfig.mockResolvedValue({ config, revision: 'rev-1' })
}

beforeEach(() => {
  vi.clearAllMocks()
  chains.current = undefined
  registry.current = {
    default: 'claude',
    engines: {
      claude: engine('claude', true, 'opus', {
        health: { state: 'exhausted', until: EXHAUSTED_UNTIL, window: '7d' },
        models: [model('opus', 'Opus'), model('sonnet', 'Sonnet')],
      }),
      codex: engine('codex', true, 'gpt-5.6-sol'),
      grok: engine('grok', false, 'grok-build', { health: { state: 'degraded' } }),
      opencode: engine('opencode', true, 'x/one', { models: [model('x/one'), model('x/two')] }),
    },
  }
  loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }] } } })
  apiMocks.updateConfig.mockResolvedValue({})
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
})

describe('a duplicate already stored in a chain', () => {
  const STORED = [{ engine: 'codex' }, { engine: 'codex' }]

  it('still shows its problem on its card, and does not stop an edit to another chain from saving', async () => {
    loadConfig({ engines: { claude: {
      accounts: { work: { configDir: '/w', fallback: STORED } },
      fallback: [{ engine: 'codex' }],
    } } })
    await renderSettings()
    expect(document.querySelector('[data-account-card="work"] [data-chain-problem]')?.textContent).toContain('duplicates')

    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))

    const sent = await save()
    expect(sent.engines.claude.fallback).toEqual([{ engine: 'codex' }, { engine: 'opencode' }])
    expect(JSON.stringify(sent.engines.claude.accounts.work.fallback)).toBe(JSON.stringify(STORED))
  })

  it('refuses an edit to that chain while it still holds the duplicate, and saves once it is fixed', async () => {
    loadConfig({ engines: { claude: { fallback: STORED } } })
    await renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    expect(await screen.findByText(/Cannot save: engines\.claude\.fallback\[1\] duplicates/)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Codex from the Claude chain' })[1])
    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'codex' }, { engine: 'opencode' }])
  })

  it('lets the unedited duplicate chain through when an unrelated setting is saved', async () => {
    loadConfig({ engines: { claude: { fallback: STORED } } })
    await renderSettings()

    fireEvent.click(screen.getByRole('switch', { name: 'Interrupt on new message' }))

    expect((await save()).engines.claude.fallback).toEqual(STORED)
  })
})
