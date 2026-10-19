import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../../page'

/* The model map as the operator edits it. Every assertion lands on one of two
 * things: what the target picker is allowed to offer, and what `api.updateConfig`
 * ends up receiving — because config.yaml is the only place this map lives. */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(), updateConfig: vi.fn(), getOrg: vi.fn(),
  sttStatus: vi.fn(), sttUpdateConfig: vi.fn(), sttDownload: vi.fn(),
}))
const fetchTalkCapability = vi.hoisted(() => vi.fn())
const registry = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/lib/talk-capability', () => ({ fetchTalkCapability }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: {}, setAccentColor: vi.fn(), setCompanyName: vi.fn(), setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(), setOperatorName: vi.fn(), setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(), resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: registry.current }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

function engine(name: string, defaultModel: string, models: string[]) {
  return {
    name, available: true, defaultModel, effortMechanism: 'none',
    models: models.map((id) => ({ id, label: id, supportsEffort: false, effortLevels: [] })),
  }
}

function card(name: string): HTMLElement {
  return document.querySelector(`[data-engine-card="${name}"]`) as HTMLElement
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

/** The add form on one card, opened. */
function openAddForm(engineName: string) {
  fireEvent.click(within(card(engineName)).getByRole('button', { name: 'Add a model mapping' }))
}

function loadConfig(engines: Record<string, unknown>) {
  apiMocks.getConfig.mockResolvedValue({ config: { engines }, revision: 'rev-1' })
}

beforeEach(() => {
  vi.clearAllMocks()
  registry.current = {
    default: 'claude',
    engines: {
      claude: engine('claude', 'claude-opus-5', ['claude-opus-5', 'claude-sonnet-5']),
      codex: engine('codex', 'gpt-5.6-sol', ['gpt-5.6-sol', 'gpt-5.6-luna']),
      grok: engine('grok', 'grok-build', ['grok-build']),
    },
  }
  loadConfig({ claude: { fallback: ['codex'] } })
  apiMocks.updateConfig.mockResolvedValue({ revision: 'rev-2' })
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
  fetchTalkCapability.mockResolvedValue({ configured: true, provider: 'openai', providers: ['openai'] })
})

describe('the floor rule', () => {
  it('names the model an unmapped pin lands on, before anything is mapped', async () => {
    await renderSettings()

    expect(within(card('claude')).getByText("Any model not listed runs on Codex's own default (gpt-5.6-sol).")).toBeTruthy()
    expect(card('claude').querySelectorAll('[data-model-map-pair]').length).toBe(0)
  })

  it('says the map has no effect when the engine has no chain, rather than hiding it', async () => {
    loadConfig({ claude: { fallback: [] } })
    await renderSettings()

    expect(within(card('claude')).getByText(/has no fallback chain, so these mappings have no effect/)).toBeTruthy()
    // Still offered: configuring the map before the chain is a legitimate order to work in.
    expect(within(card('claude')).getByRole('button', { name: 'Add a model mapping' })).toBeTruthy()
  })
})

describe('adding a mapping', () => {
  it('offers this engine models as sources and accepts a typed id', async () => {
    await renderSettings()
    openAddForm('claude')
    const source = within(card('claude')).getByLabelText('Model to carry off Claude')
    const suggested = Array.from(
      card('claude').querySelectorAll('datalist option'),
    ).map((option) => (option as HTMLOptionElement).value)

    expect(suggested).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    // A picker that does not constrain: the registry may not know every pin yet.
    fireEvent.change(source, { target: { value: 'claude-opus-9' } })
    expect((source as HTMLInputElement).value).toBe('claude-opus-9')
  })

  it('offers ONLY models the first substitute serves as targets', async () => {
    await renderSettings()
    openAddForm('claude')
    const target = within(card('claude')).getByRole('combobox', { name: 'Model to run as instead, for Claude' })
    const offered = within(target).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)

    expect(offered).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
    // A model id belongs to one provider; carrying a Claude id onto Codex is the bug.
    expect(offered).not.toContain('claude-opus-5')
    expect(offered).not.toContain('claude-sonnet-5')
  })

  it('round-trips the new row into what the gateway receives', async () => {
    await renderSettings()
    openAddForm('claude')
    fireEvent.change(within(card('claude')).getByLabelText('Model to carry off Claude'), {
      target: { value: 'claude-opus-5' },
    })
    fireEvent.change(within(card('claude')).getByRole('combobox', { name: 'Model to run as instead, for Claude' }), {
      target: { value: 'gpt-5.6-luna' },
    })
    fireEvent.click(within(card('claude')).getByRole('button', { name: 'Add mapping' }))

    expect(within(card('claude')).getByText('claude-opus-5')).toBeTruthy()
    expect((await save()).engines.claude.fallbackModelMap).toEqual({ 'claude-opus-5': 'gpt-5.6-luna' })
  })

  it('adds nothing when Cancel is pressed on a half-filled form', async () => {
    await renderSettings()
    openAddForm('claude')
    fireEvent.change(within(card('claude')).getByLabelText('Model to carry off Claude'), {
      target: { value: 'claude-opus-5' },
    })
    fireEvent.click(within(card('claude')).getByRole('button', { name: 'Cancel' }))

    // Cancel is not a submit: the form closes without handing the pair to the writer.
    expect(within(card('claude')).queryByLabelText('Model to carry off Claude')).toBeNull()
    expect(card('claude').querySelectorAll('[data-model-map-pair]')).toHaveLength(0)
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })
})

describe('editing and removing', () => {
  beforeEach(() => {
    loadConfig({ claude: { fallback: ['codex'], fallbackModelMap: { 'claude-opus-5': 'gpt-5.6-sol' } } })
  })

  it('retargets a row in place', async () => {
    await renderSettings()
    fireEvent.change(
      within(card('claude')).getByRole('combobox', { name: 'Model claude-opus-5 runs as on the Claude stand-in' }),
      { target: { value: 'gpt-5.6-luna' } },
    )

    expect((await save()).engines.claude.fallbackModelMap).toEqual({ 'claude-opus-5': 'gpt-5.6-luna' })
  })

  it('writes null for a map emptied in the UI, because {} would merge to no change', async () => {
    await renderSettings()
    fireEvent.click(within(card('claude')).getByRole('button', { name: 'Remove the mapping for claude-opus-5 from Claude' }))

    expect(card('claude').querySelectorAll('[data-model-map-pair]').length).toBe(0)
    expect((await save()).engines.claude.fallbackModelMap).toBeNull()
  })
})

describe('an entry the substitute stopped serving', () => {
  beforeEach(() => {
    // Grok is first now, and grok does not serve the Codex model this map names.
    loadConfig({ claude: { fallback: ['grok', 'codex'], fallbackModelMap: { 'claude-opus-5': 'gpt-5.6-sol' } } })
  })

  it('says so in the config loader own words, and refuses the save', async () => {
    await renderSettings()

    expect(within(card('claude')).getByText(
      'engines.claude.fallbackModelMap["claude-opus-5"] maps to "gpt-5.6-sol", which engine "grok" does not serve',
    )).toBeTruthy()

    // Any edit now asks for a write, and this document is the one that cannot have one.
    fireEvent.click(screen.getByRole('switch', { name: 'Interrupt on new message' }))

    expect(await screen.findByText(/Cannot save: engines\.claude\.fallbackModelMap/)).toBeTruthy()
    // Refused before the wire, not by the gateway after a round trip.
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })

  it('saves once the target is one grok actually serves', async () => {
    await renderSettings()
    fireEvent.change(
      within(card('claude')).getByRole('combobox', { name: 'Model claude-opus-5 runs as on the Claude stand-in' }),
      { target: { value: 'grok-build' } },
    )

    expect(card('claude').querySelector('[data-model-map-problem]')).toBeNull()
    expect((await save()).engines.claude.fallbackModelMap).toEqual({ 'claude-opus-5': 'grok-build' })
  })
})
