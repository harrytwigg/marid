import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import SettingsPage from '../../page'

/* The Engine Fallbacks section as the operator drives it: chains are edited into the
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

/** For a test that edits more than once: the write that follows the last edit, once the debounce has gone quiet. */
async function saveLast() {
  await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 700))
  return apiMocks.updateConfig.mock.calls.at(-1)![0] as Record<string, any>
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

describe('Engine Fallbacks section', () => {
  it('is titled for what it configures — the chain a limited engine falls through to', async () => {
    await renderSettings()

    expect(screen.getByText('Engine Fallbacks')).toBeTruthy()
  })

  it('lists every engine with its installed state, default model and health', async () => {
    await renderSettings()

    expect(screen.getByText('Installed · opus')).toBeTruthy()
    expect(screen.getByText('Installed · gpt-5.6-sol')).toBeTruthy()
    // Uninstalled engines are listed too, not hidden.
    expect(screen.getByText('Not installed · grok-build')).toBeTruthy()
    expect(screen.getByText('Weekly limit, back in 6d')).toBeTruthy()
    expect(screen.getByText('Degraded')).toBeTruthy()
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0)
  })

  it('shows each link as engine, profile (Claude only) and model, with the profile choices Default plus the declared accounts', async () => {
    loadConfig({ engines: { claude: {
      accounts: { work: { configDir: '/w' } },
      fallback: [{ engine: 'claude', profile: 'work', model: 'sonnet' }, { engine: 'opencode', model: 'x/two' }],
    } } })
    await renderSettings()

    const profile = screen.getByRole('combobox', { name: 'Profile of link 1 of the Claude chain' }) as HTMLSelectElement
    expect(profile.value).toBe('work')
    expect(within(profile).getAllByRole('option').map((o) => o.textContent)).toEqual(['Default profile', 'work'])
    expect(screen.getByRole('button', { name: 'Model of link 1 of the Claude chain: Sonnet' })).toBeTruthy()
    // opencode takes no profile: its row has two fields, not three.
    expect(screen.queryByRole('combobox', { name: 'Profile of link 2 of the Claude chain' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Model of link 2 of the Claude chain: x/two' })).toBeTruthy()
  })

  it('saves an added target as an object link, the array replaced as a whole', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    expect(engineRows('claude')).toEqual(['codex', 'opencode'])

    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'codex' }, { engine: 'opencode' }])
  })

  it('saves a changed engine, profile and model on the row that changed', async () => {
    loadConfig({ engines: { claude: { accounts: { work: { configDir: '/w' } }, fallback: [{ engine: 'codex' }] } } })
    await renderSettings()
    fireEvent.change(screen.getByRole('combobox', { name: 'Engine of link 1 of the Claude chain' }), { target: { value: 'claude' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Profile of link 1 of the Claude chain' }), { target: { value: 'work' } })
    fireEvent.keyDown(screen.getByRole('button', { name: /Model of link 1 of the Claude chain/ }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Sonnet/ }))

    expect((await saveLast()).engines.claude.fallback).toEqual([{ engine: 'claude', profile: 'work', model: 'sonnet' }])
  })

  it('writes no model for "Same model" / "Engine default", and says which one it is', async () => {
    loadConfig({ engines: { claude: {
      accounts: { a: { configDir: '/a' } },
      fallback: [{ engine: 'claude', profile: 'a', model: 'sonnet' }, { engine: 'codex', model: 'gpt-5.6-sol' }],
    } } })
    await renderSettings()
    fireEvent.keyDown(screen.getByRole('button', { name: /Model of link 2 of the Claude chain/ }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Engine default' }))

    expect((await save()).engines.claude.fallback[1]).toEqual({ engine: 'codex' })
    expect(screen.getByRole('button', { name: 'Model of link 2 of the Claude chain: Engine default' })).toBeTruthy()
  })

  it('asks for the gateway view of the chains again once a save has landed', async () => {
    const { queryClient } = await import('@/lib/query-client')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    await save()

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['fallback-chains'] }))
  })

  it('saves a chain emptied in the UI as [], and says the engine waits', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Codex from the Claude chain' }))

    expect(screen.getByText('No fallback. Claude waits for its own limit to reset.')).toBeTruthy()
    expect((await save()).engines.claude.fallback).toEqual([])
  })

  it('reorders with the move controls a keyboard can reach', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }, { engine: 'opencode' }] } } })
    await renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Move opencode earlier in the Claude chain' }))
    expect(engineRows('claude')).toEqual(['opencode', 'codex'])
    expect((await save()).engines.claude.fallback).toEqual([{ engine: 'opencode' }, { engine: 'codex' }])
  })

  it('refuses a duplicate under its row in the loader sentence, and writes nothing', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex' }] } } })
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))
    fireEvent.change(screen.getAllByRole('combobox', { name: /^Engine of link 2/ })[0], { target: { value: 'codex' } })

    const problem = document.querySelector('[data-chain-problem]')!
    expect(problem.textContent).toBe('engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once')
    expect(problem.closest('[data-engine-card]')?.getAttribute('data-engine-card')).toBe('claude')
    expect(await screen.findByText(/Cannot save: engines\.claude\.fallback\[1\] duplicates/)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })

  it('shows the map on the engine that falls through rather than on the stand-in', async () => {
    loadConfig({
      engines: {
        claude: { fallback: [{ engine: 'codex' }] },
        codex: { fallback: [{ engine: 'claude' }], fallbackModelMap: { 'gpt-5.6-luna': 'haiku' } },
      },
    })
    await renderSettings()
    const codexCard = document.querySelector('[data-engine-card="codex"]') as HTMLElement

    expect(within(codexCard).getByText('Models carried onto the stand-in')).toBeTruthy()
    expect(codexCard.querySelector('[data-model-map-pair="gpt-5.6-luna"]')).toBeTruthy()
    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-pair]')).toBeNull()
  })

  it('states the floor rule for an engine with no mappings, rather than nothing at all', async () => {
    await renderSettings()

    expect(document.querySelectorAll('[data-model-map-pair]').length).toBe(0)
    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')?.textContent)
      .toContain("Codex's own default")
  })

  it('reads a chain of mixed string and object entries, whichever way each was written', async () => {
    loadConfig({ engines: { claude: { fallback: ['codex', { engine: 'opencode', model: 'x/two' }, { engine: 'codex', model: 'gpt-5.6-sol' }] } } })
    await renderSettings()

    expect(engineRows('claude')).toEqual(['codex', 'opencode · x/two', 'codex · gpt-5.6-sol'])
    expect(document.querySelector('[data-engine-card="claude"] [data-chain-legacy-notice]')).toBeTruthy()
    // The map follows the links that name no model and leave the engine: only the bare "codex" one.
    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')?.textContent).toContain("Codex's own default")
  })

  it('hides the map when every link names a model, since it would translate nothing', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex', model: 'gpt-5.6-sol' }] } } })
    await renderSettings()

    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')).toBeNull()
  })

  it('keeps the map for a link without a model', async () => {
    loadConfig({ engines: { claude: { fallback: [{ engine: 'codex', model: 'gpt-5.6-sol' }, { engine: 'opencode' }] } } })
    await renderSettings()

    expect(document.querySelector('[data-engine-card="claude"] [data-model-map-floor]')?.textContent).toContain("opencode's own default")
  })

  it('surfaces a failed save and leaves the edited chain on screen', async () => {
    apiMocks.updateConfig.mockRejectedValue(new Error('engines.claude.fallback[1] "opencode" is not a known engine'))
    await renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Add a target to the Claude chain' }))

    expect(await screen.findByText(/Failed to save: engines\.claude\.fallback\[1\]/)).toBeTruthy()
    expect(engineRows('claude')).toEqual(['codex', 'opencode'])
  })
})
