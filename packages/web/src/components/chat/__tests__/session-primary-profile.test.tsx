import "@/test/preload-menus"
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EnginesResponse } from '@/lib/api'

function renderRow(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) {
    g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
})

const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag',
      models: [{ id: 'opus', label: 'Opus 4.8', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] }],
    },
    opencode: {
      name: 'opencode', available: true, defaultModel: 'opencode-go/x', effortMechanism: 'none',
      models: [{ id: 'opencode-go/x', label: 'X', supportsEffort: false, effortLevels: [] }],
    },
  },
}

vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})

// `null` = the chains read has not loaded (or failed): data is undefined.
const profilesHolder: { current: string[] | null } = { current: ['work'] }
// Accounts declared on another host: the chains read lists them too, for a remote employee's fallback.
const remoteProfilesHolder: { current: string[] } = { current: [] }
vi.mock('@/hooks/use-fallback-chains', () => ({
  useFallbackChains: () => ({
    data: profilesHolder.current
      ? {
          profiles: [
            ...profilesHolder.current.map((name) => ({ name, account: name, configDir: `/x/${name}` })),
            ...remoteProfilesHolder.current.map((name) => ({ name, account: `claude@ci@box:${name}`, configDir: `/x/${name}`, remote: { host: 'box', destination: 'ci@box' } })),
          ],
          subjects: [],
        }
      : undefined,
  }),
}))

const previewCalls: unknown[] = []
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getFallbackPreview: (selection: unknown) => {
        previewCalls.push(selection)
        return Promise.resolve({ fallback: null })
      },
    },
  }
})

import { ModelSelectorRow, type SelectorValue } from '../model-selector-row'
import { useNewChatFallback } from '../use-new-chat-fallback'
import { renderHook } from '@testing-library/react'
import { buildFreshChatParams, buildNewSessionParams, composeSessionEngine, effectivePrimaryProfile, resolveNewSessionSelector, startableProfileNames } from '../new-chat-helpers'
import { readNewSessionSelector, writeNewSessionSelector } from '../new-session-selector'

function Harness({ initial, onChange }: { initial: SelectorValue; onChange?: (v: SelectorValue) => void }) {
  const [val, setVal] = useState<SelectorValue>(initial)
  return (
    <ModelSelectorRow
      mode="new"
      allowProfiles
      value={val}
      onChange={(v) => { setVal(v); onChange?.(v) }}
    />
  )
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: /model and effort/i }), { key: 'Enter' })
}

describe('primary profile wire composition', () => {
  it('starts only on local accounts: a remote-declared one is not a primary the gateway takes', () => {
    const chains = {
      profiles: [
        { name: 'work', account: 'claude:1', configDir: '/x/work' },
        { name: 'box', account: 'claude@ci@box:2', configDir: '/x/box', remote: { host: 'box', destination: 'ci@box' } },
      ],
    }
    expect(startableProfileNames(chains)).toEqual(['work'])
    expect(effectivePrimaryProfile({ profile: 'box', declared: startableProfileNames(chains) })).toBeUndefined()
    expect(startableProfileNames(undefined)).toBeUndefined()
  })

  it('composes claude:<name> for create, and only for claude', () => {
    expect(composeSessionEngine('claude', 'work')).toBe('claude:work')
    expect(composeSessionEngine('claude', undefined)).toBe('claude')
    expect(composeSessionEngine('opencode', 'work')).toBe('opencode')
    const params = buildNewSessionParams({ message: 'hi', selectedEmployee: null, engine: 'claude', profile: 'work' })
    expect(params.engine).toBe('claude:work')
    const bare = buildNewSessionParams({ message: 'hi', selectedEmployee: null, engine: 'claude' })
    expect(bare.engine).toBe('claude')
  })

  it('keeps the profile beside the bare engine in the remembered selection', () => {
    const resolved = resolveNewSessionSelector({
      storedSelector: { engine: 'claude', model: 'opus', profile: 'work' },
      manuallyChanged: false,
    })
    expect(resolved).toEqual({ engine: 'claude', model: 'opus', profile: 'work' })
    const offClaude = resolveNewSessionSelector({
      storedSelector: { engine: 'opencode', model: 'x', profile: 'work' },
      manuallyChanged: false,
    })
    expect(offClaude.profile).toBeUndefined()

    writeNewSessionSelector({ engine: 'claude', model: 'opus', profile: 'work' })
    expect(readNewSessionSelector()).toEqual({ engine: 'claude', model: 'opus', profile: 'work' })
  })
})

describe('fallback preview for a chosen profile', () => {
  it('previews the chain of the composed claude:<name> engine', async () => {
    previewCalls.length = 0
    renderHook(() => useNewChatFallback({ active: true, engine: composeSessionEngine('claude', 'work'), model: 'opus' }))
    await waitFor(() => expect(previewCalls.length).toBeGreaterThan(0))
    expect(previewCalls[0]).toEqual(expect.objectContaining({ engine: 'claude:work', model: 'opus' }))
  })
})

describe('ModelSelectorRow primary profile picker', () => {
  beforeEach(() => { profilesHolder.current = ['work']; remoteProfilesHolder.current = [] })

  it('offers only accounts on this machine, never one declared on another host', async () => {
    remoteProfilesHolder.current = ['box']
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: 'box' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).not.toContain('box')
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    expect(await screen.findByRole('menuitem', { name: /claude · work/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /claude · box/i })).toBeNull()
  })

  it('lists Claude once per declared profile and picking one records it beside the engine', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    expect(await screen.findByRole('menuitem', { name: /^claude$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /claude · work/i }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude', model: 'opus', profile: 'work' }))
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).toContain('Claude · work · Opus 4.8')
  })

  it('with no declared accounts the engine panel is exactly as before', async () => {
    profilesHolder.current = []
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus' }} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    expect(await screen.findByRole('menuitem', { name: /^claude$/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /claude ·/i })).toBeNull()
  })

  it('switching to another engine drops the profile', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: 'work' }} onChange={onChange} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^opencode$/i }))
    const last = onChange.mock.calls.at(-1)?.[0] as SelectorValue
    expect(last.engine).toBe('opencode')
    expect(last.profile).toBeUndefined()
  })

  it('does not offer or show a remembered profile that is no longer declared, and never rewrites the choice', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: 'gone' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).not.toContain('gone')
    // The correction is derived: nothing is reported as a user edit, so employee defaults keep applying and storage is untouched.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows no remembered profile until the chains read has confirmed it', () => {
    profilesHolder.current = null
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: 'work' }} />)
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).not.toContain('work')
  })

  it('shows no remembered profile for a remote employee, and leaves the choice alone', () => {
    const onChange = vi.fn()
    renderRow(
      <ModelSelectorRow mode="new" allowProfiles employeeRemote value={{ engine: 'claude', model: 'opus', profile: 'work' }} onChange={onChange} />,
    )
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).not.toContain('work')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows the profile for an existing session only while it is on claude', () => {
    renderRow(
      <ModelSelectorRow mode="existing" sessionProfileName="work" value={{ engine: 'opencode', model: 'opencode-go/x' }} onChange={() => {}} />,
    )
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).not.toContain('work')
  })

  it('keeps a long profile name in the collapsed label, which truncates rather than growing the chip', () => {
    const long = 'a-very-long-declared-account-name-for-the-work-login'
    profilesHolder.current = [long]
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: long }} />)
    const trigger = screen.getByRole('button', { name: /model and effort/i })
    expect(trigger.getAttribute('aria-label')).toContain(`Claude · ${long} · Opus 4.8`)
    expect(trigger.className).toContain('max-w-full')
    expect(trigger.querySelector('.truncate')).toBeTruthy()
  })

  it('hides the profile rows for a remote employee', async () => {
    renderRow(
      <ModelSelectorRow mode="new" allowProfiles employeeRemote value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />,
    )
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    expect(await screen.findByRole('menuitem', { name: /^claude$/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /claude ·/i })).toBeNull()
  })

  it('shows an existing session profile in the collapsed label, read-only', () => {
    renderRow(
      <ModelSelectorRow mode="existing" sessionProfileName="work" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />,
    )
    expect(screen.getByRole('button', { name: /model and effort/i }).getAttribute('aria-label')).toContain('Claude · work · Opus 4.8')
  })
})

describe('effectivePrimaryProfile', () => {
  it('only passes a profile confirmed declared for a local employee', () => {
    expect(effectivePrimaryProfile({ profile: 'work', declared: ['work'] })).toBe('work')
    expect(effectivePrimaryProfile({ profile: 'work', declared: undefined })).toBeUndefined()
    expect(effectivePrimaryProfile({ profile: 'work', declared: [] })).toBeUndefined()
    expect(effectivePrimaryProfile({ profile: 'gone', declared: ['work'] })).toBeUndefined()
    expect(effectivePrimaryProfile({ profile: 'work', declared: ['work'], employeeRemote: true })).toBeUndefined()
    expect(effectivePrimaryProfile({ declared: ['work'] })).toBeUndefined()
  })
})

describe('a fresh continuation chat', () => {
  const previous = { employee: 'lead', engine: 'claude', model: 'opus', effortLevel: 'high', profile: 'work' }

  it('continues on the previous session\'s Claude account', () => {
    expect(buildFreshChatParams({ message: 'go', previous })).toMatchObject({ employee: 'lead', engine: 'claude:work', model: 'opus', effortLevel: 'high' })
  })

  it('does not send the profile for a remote employee, or when there was none', () => {
    expect(buildFreshChatParams({ message: 'go', previous, employeeRemote: true }).engine).toBe('claude')
    expect(buildFreshChatParams({ message: 'go', previous: { ...previous, profile: undefined } }).engine).toBe('claude')
  })
})
