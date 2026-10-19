import { render, screen } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import SettingsPage from '../../page'

/* The opencode internal-fallback warning on the Engine Fallbacks section, in the same harness as
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

describe('the opencode internal fallback warning', () => {
  const withOpencode = (internalFallback: unknown) => {
    const reg = registry.current as { engines: Record<string, unknown> }
    reg.engines.opencode = engine('opencode', true, 'x/one', { internalFallback })
  }

  it('warns on the opencode card, with a link to the migration, while the plugin is still active', async () => {
    withOpencode({ detected: true, neutralised: false, sources: ['/home/op/.config/opencode/opencode.json'] })
    await renderSettings()

    const warning = document.querySelector('[data-engine-card="opencode"] [data-opencode-internal-fallback]')!
    expect(warning.getAttribute('data-opencode-internal-fallback')).toBe('active')
    expect((warning.querySelector('a') as HTMLAnchorElement).href).toContain('docs/fallback-chains.md#migrating-a-host')
    // The way out: the migration, then `jinn doctor`; the operator's own paths are never shown.
    expect(warning.querySelector('[data-opencode-doctor]')?.textContent).toBe('jinn doctor')
    expect(warning.textContent).not.toContain('/home/op')
  })

  it('says only the remote hosts when this host does not carry it', async () => {
    // As the gateway reports it: a remote host's findings are part of `sources`, as "host: path".
    withOpencode({ detected: true, neutralised: false, sources: ['build-1: x', 'build-2: y'], remote: [{ host: 'build-1', sources: ['x'] }, { host: 'build-2', sources: ['y'] }] })
    await renderSettings()

    const warning = document.querySelector('[data-opencode-internal-fallback]')!
    expect(warning.textContent).toContain('installed on 2 remote hosts')
    expect(warning.textContent).not.toContain('here and')
    expect(warning.textContent).not.toContain('build-1')
  })

  it('says here and how many remote hosts, when both carry it', async () => {
    withOpencode({ detected: true, neutralised: false, sources: ['/local/opencode.json', 'build-1: x'], remote: [{ host: 'build-1', sources: ['x'] }] })
    await renderSettings()

    expect(document.querySelector('[data-opencode-internal-fallback]')!.textContent).toContain('here and on 1 remote host')
  })

  it('says it is neutralised, with no link, once the gateway runs opencode with it off', async () => {
    withOpencode({ detected: true, neutralised: true, sources: ['/home/op/.config/opencode/opencode.json'] })
    await renderSettings()

    const warning = document.querySelector('[data-opencode-internal-fallback]')!
    expect(warning.getAttribute('data-opencode-internal-fallback')).toBe('neutralised')
    expect(warning.querySelector('a')).toBeNull()
  })

  it('shows nothing when none is detected, or the gateway does not say', async () => {
    withOpencode({ detected: false, neutralised: false, sources: [] })
    await renderSettings()
    expect(document.querySelector('[data-opencode-internal-fallback]')).toBeNull()
  })
})
