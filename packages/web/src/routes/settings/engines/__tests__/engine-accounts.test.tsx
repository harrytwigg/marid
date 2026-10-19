import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import SettingsPage from '../../page'

/* Claude accounts, legacy chains, the opencode warning and the legacy mapping on the Engine Fallbacks
 * section, in the same harness as engines-section.test.tsx. Chains are edited into the
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

/** The chain rows on one card, in the order they are rendered. */
function chainRows(cardSelector: string): string[] {
  const card = document.querySelector(cardSelector)!
  return Array.from(card.querySelectorAll('[data-chain-row]')).map((row) => row.getAttribute('data-chain-row')!)
}
const engineRows = (name: string) => chainRows(`[data-engine-card="${name}"]`)
const accountRows = (name: string) => chainRows(`[data-account-card="${name}"]`)

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

describe('Claude accounts', () => {
  beforeEach(() => {
    loadConfig({ engines: {
      claude: { accounts: { work: { configDir: '/w', fallback: [{ engine: 'opencode', model: 'x/two' }] }, spare: { configDir: '/s' } } },
    } })
  })

  it('gives each declared account its own chain card, under the Claude card and named for the account', async () => {
    await renderSettings()

    const cards = Array.from(document.querySelectorAll('[data-account-card]')).map((card) => card.getAttribute('data-account-card'))
    expect(cards).toEqual(['work', 'spare'])
    expect(accountRows('work')).toEqual(['opencode · x/two'])
    const claude = document.querySelector('[data-engine-card="claude"]')!
    expect(claude.compareDocumentPosition(document.querySelector('[data-account-card="work"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('writes an account chain under the account, and leaves the engine chain alone', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude · spare chain' }))

    const sent = await save()
    expect(sent.engines.claude.accounts.spare.fallback).toEqual([{ engine: 'claude' }])
    expect(sent.engines.claude.accounts.work.fallback).toEqual([{ engine: 'opencode', model: 'x/two' }])
    expect(sent.engines.claude.fallback).toBeUndefined()
  })
})

describe('what a save leaves alone', () => {
  const RAW_ACCOUNT = ['codex', { engine: 'opencode', model: 'x/two', note: 'kept as written' }]

  it('writes an untouched account chain back byte for byte while an engine chain is edited', async () => {
    loadConfig({ engines: { claude: {
      accounts: { work: { configDir: '/w', fallback: RAW_ACCOUNT } },
      fallback: [{ engine: 'codex' }, { engine: 'opencode', model: 'x/two' }],
    } } })
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Move opencode · x/two earlier in the Claude chain' }))

    const sent = await save()
    expect(sent.engines.claude.fallback).toEqual([{ engine: 'opencode', model: 'x/two' }, { engine: 'codex' }])
    expect(JSON.stringify(sent.engines.claude.accounts.work.fallback)).toBe(JSON.stringify(RAW_ACCOUNT))
  })

  it('reorders a chain of mixed string and object entries into the expected objects', async () => {
    loadConfig({ engines: { claude: { fallback: ['codex', { engine: 'opencode', model: 'x/two' }] } } })
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Move opencode · x/two earlier in the Claude chain' }))

    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'opencode', model: 'x/two' }, { engine: 'codex' }])
  })

  it('keeps an object entry the operator did not touch exactly as written, whichever row moves', async () => {
    const raw = { engine: 'opencode', model: 'x/two', note: 'kept as written' }
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }, raw] } } })
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Move Codex later in the Claude chain' }))

    const written = (await save()).engines.claude.fallback
    expect(written).toEqual([raw, { engine: 'codex' }])
    expect(JSON.stringify(written[0])).toBe(JSON.stringify(raw))
  })
})

describe('the gateway problems with a chain', () => {
  it('shows what the gateway reports on an engine card and on an account card', async () => {
    loadConfig({ engines: { claude: { accounts: { work: { configDir: '/w' } }, fallback: [{ engine: 'codex' }] } } })
    chains.current = {
      profiles: [],
      subjects: [
        { kind: 'engine', id: 'claude', primary: null, configured: [], legacy: false, effective: [], problems: ['engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex)'] },
        { kind: 'account', id: 'work', primary: null, configured: [], legacy: false, effective: [], problems: ['engines.claude.accounts.work.fallback[0] names an unknown profile'] },
      ],
    }
    await renderSettings()

    expect(document.querySelector('[data-engine-card="claude"] [data-chain-problem]')?.textContent).toContain('duplicates')
    expect(document.querySelector('[data-account-card="work"] [data-chain-problem]')?.textContent).toContain('unknown profile')
  })

  it('does not say a sentence twice when the editor already shows it under its row', async () => {
    const sentence = 'engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once'
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }, { engine: 'codex' }] } } })
    chains.current = { profiles: [], subjects: [{ kind: 'engine', id: 'claude', primary: null, configured: [], legacy: false, effective: [], problems: [sentence] }] }
    await renderSettings()

    expect(screen.getAllByText(sentence).length).toBe(1)
  })
})

describe('a legacy chain', () => {
  const effective = [
    { engine: 'codex', key: 'codex||', account: 'codex', label: 'codex', origin: 'config' },
    { engine: 'opencode', key: 'opencode||', account: 'opencode', label: 'opencode', origin: 'legacy' },
  ]

  beforeEach(() => {
    loadConfig({ engines: { claude: { fallback: ['codex'] }, codex: { fallback: ['opencode'] } } })
    chains.current = { profiles: [], subjects: [{ kind: 'engine', id: 'claude', primary: null, configured: [{ engine: 'codex' }], legacy: true, effective }] }
  })

  it('shows what runs, badges the link another chain contributed, and says so once', async () => {
    await renderSettings()

    expect(engineRows('claude')).toEqual(['codex', 'opencode'])
    const card = document.querySelector('[data-engine-card="claude"]')!
    expect(card.querySelectorAll('[data-chain-expanded]').length).toBe(1)
    expect(card.querySelector('[data-chain-legacy-notice]')?.textContent).toContain('shown as it runs')
  })

  it('writes nothing until the first edit, which materialises the whole effective chain as links', async () => {
    await renderSettings()
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Move opencode earlier in the Claude chain' }))

    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'opencode' }, { engine: 'codex' }])
  })
})

describe('legacy fallback mapping', () => {
  beforeEach(() => {
    // What GET /api/config serves for a legacy config: the mapped chain in the
    // current spelling, with the deprecated pair still on the document.
    loadConfig({
      engines: { claude: { fallback: [{ engine: 'codex' }] } },
      sessions: { rateLimitStrategy: 'fallback', fallbackEngine: 'codex' },
    })
  })

  it('shows the mapping read-only, and migrating writes the chain and nulls both legacy keys', async () => {
    await renderSettings()
    expect(screen.getByText('An older setting still routes Claude here. Migrate it into the chain above.')).toBeTruthy()
    // Read-only: nothing edits the legacy pair but the one Migrate control.
    expect(screen.queryByRole('combobox', { name: 'When Claude Hits Usage Limit' })).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Migrate' })) })
    expect(screen.queryByRole('button', { name: 'Migrate' })).toBeNull()

    const sent = await save()
    expect(sent.engines.claude.fallback).toEqual([{ engine: 'codex' }])
    // Null, not absent: the gateway keeps every key a PUT omits, so an omitted
    // key would leave the deprecated pair on disk.
    expect(Object.keys(sent.sessions)).toEqual(expect.arrayContaining(['rateLimitStrategy', 'fallbackEngine']))
    expect(sent.sessions.rateLimitStrategy).toBeNull()
    expect(sent.sessions.fallbackEngine).toBeNull()
  })
})
