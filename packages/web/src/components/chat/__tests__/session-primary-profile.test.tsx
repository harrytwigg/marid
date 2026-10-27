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

const profilesHolder: { current: string[] } = { current: ['work'] }
vi.mock('@/hooks/use-fallback-chains', () => ({
  useFallbackChains: () => ({
    data: { profiles: profilesHolder.current.map((name) => ({ name, account: name, configDir: `/x/${name}` })), subjects: [] },
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
import { buildNewSessionParams, composeSessionEngine, resolveNewSessionSelector } from '../new-chat-helpers'
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
  beforeEach(() => { profilesHolder.current = ['work'] })

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

  it('drops a remembered profile that is no longer declared', async () => {
    const onChange = vi.fn()
    renderRow(<Harness initial={{ engine: 'claude', model: 'opus', profile: 'gone' }} onChange={onChange} />)
    await waitFor(() => {
      const calls = onChange.mock.calls.map((c) => c[0] as SelectorValue)
      expect(calls.some((v) => v.profile === undefined && v.engine === 'claude')).toBe(true)
    })
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
