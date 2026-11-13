import "@/test/preload-menus"
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import type { EngineRegistryEntry, EnginesResponse } from '@/lib/api'
import type { SessionFallbackView } from '../fallback-mode-model'

/**
 * Declared opencode accounts (engines.opencode.accounts) are separate rows in "Switch engine", in the new-chat
 * selector and in the fallback chip's picker; with none declared, opencode is the single row it always was.
 */

const apiMocks = vi.hoisted(() => ({ getEngineLimits: vi.fn(), refreshEngines: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id.slice(id.indexOf('/') + 1), supportsEffort: false, effortLevels: [], ...extra })
const claude: EngineRegistryEntry = { name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag', models: [{ id: 'opus', label: 'Opus 4.8', supportsEffort: false, effortLevels: [] }] }
const opencode = (models: ReturnType<typeof model>[]): EngineRegistryEntry => ({ name: 'opencode', available: true, defaultModel: 'opencode-go/glm-5.3', effortMechanism: 'none', models })
const GO_A = [model('opencode-go/glm-5.3'), model('opencode-go/kimi-k3')]
// The alias provider's models carry `account`; the built-in provider's do not.
const GO_B = [model('opencode-go-b/glm-5.3', { account: 'go-b' }), model('opencode-go-b/kimi-k3', { account: 'go-b' })]
const OTHER = [model('opencode/big-pickle')]

const REG: EnginesResponse = { default: 'claude', engines: { claude, opencode: opencode([...GO_A, ...GO_B]) } }
const REG_WITH_OTHER: EnginesResponse = { default: 'claude', engines: { claude, opencode: opencode([...GO_A, ...GO_B, ...OTHER]) } }

const regHolder: { current: EnginesResponse } = { current: REG }
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: regHolder.current, isLoading: false }) }
})

import { ModelSelectorRow, type SelectorValue } from '../model-selector-row'
import { FallbackTargetPicker } from '../fallback-target-picker'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const DECLARED = {
  generatedAt: 'now', default: 'claude', engines: {},
  accounts: { opencode: [
    { account: 'go-a', label: 'go-a', provider: 'opencode-go' },
    { account: 'go-b', label: 'go-b', provider: 'opencode-go-b', base: 'opencode-go' },
  ] },
}

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const proto = Element.prototype as unknown as Record<string, unknown>
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {}
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {}
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {}
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({ matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as MediaQueryList
  }
})

beforeEach(() => {
  regHolder.current = REG
  apiMocks.getEngineLimits.mockReset()
  apiMocks.getEngineLimits.mockResolvedValue(DECLARED)
})

function renderUi(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function Harness({ initial, onChange }: { initial: SelectorValue; onChange?: (v: SelectorValue) => void }) {
  const [val, setVal] = useState(initial)
  return <ModelSelectorRow mode="new" value={val} onChange={(v) => { setVal(v); onChange?.(v) }} />
}
const chip = () => screen.getByRole('button', { name: /model and effort/i })
const openMenu = () => fireEvent.keyDown(chip(), { key: 'Enter' })
const engineRows = () => screen.getAllByRole('menuitem').map((el) => el.textContent ?? '')
async function openEnginePanel() {
  openMenu()
  fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
  await screen.findByRole('menuitem', { name: /^back$/i })
}
const modelNames = () => screen.getAllByRole('menuitemradio').map((el) => el.textContent ?? '')

describe('Switch engine in the new-chat selector', () => {
  it('lists each declared opencode account on its own row, in place of the single opencode row', async () => {
    renderUi(<Harness initial={{ engine: 'claude', model: 'opus' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalledWith('opencode'))
    await openEnginePanel()
    await waitFor(() => expect(engineRows()).toContain('opencode · go-a'))
    const rows = engineRows()
    expect(rows).toContain('opencode · go-b')
    expect(rows).toContain('Claude')
    expect(rows).not.toContain('opencode')
    // Every model is served by a declared account, so there is no row for "the rest".
    expect(rows.some((r) => /other providers/i.test(r))).toBe(false)
  })

  it('still offers the models no declared account serves, on their own row', async () => {
    regHolder.current = REG_WITH_OTHER
    renderUi(<Harness initial={{ engine: 'claude', model: 'opus' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())
    await openEnginePanel()
    await waitFor(() => expect(engineRows()).toContain('opencode · go-a'))
    expect(engineRows()).toContain('opencode · Other providers')
  })

  it('picking an account selects a model of that account\'s provider and lists only its models', async () => {
    const onChange = vi.fn()
    renderUi(<Harness initial={{ engine: 'claude', model: 'opus' }} onChange={onChange} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())
    await openEnginePanel()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'opencode · go-b' }))
    // The engine's default model is go-a's, so go-b starts on its own first model.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ engine: 'opencode', model: 'opencode-go-b/glm-5.3' }))
    expect(await screen.findByText(/Engine · opencode · go-b/)).toBeTruthy()
    expect(modelNames().map((n) => n.replace(/go-b$/, ''))).toEqual(['glm-5.3', 'kimi-k3'])
    expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · go-b · glm-5.3')

    // And back to go-a: the engine's default model is one of its own.
    fireEvent.click(screen.getByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'opencode · go-a' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ engine: 'opencode', model: 'opencode-go/glm-5.3' }))
    expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · go-a · glm-5.3')
  })

  it('shows only the current model\'s account and marks that account\'s row', async () => {
    renderUi(<Harness initial={{ engine: 'opencode', model: 'opencode-go-b/kimi-k3' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())
    openMenu()
    expect(await screen.findByText(/Engine · opencode · go-b/)).toBeTruthy()
    expect(modelNames()).toHaveLength(2)
    fireEvent.click(screen.getByRole('menuitem', { name: /switch engine/i }))
    const goB = await screen.findByRole('menuitem', { name: 'opencode · go-b' })
    expect(goB.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'opencode · go-a' }).getAttribute('aria-checked')).toBe('false')
  })

  it('is unchanged with no accounts declared: one "opencode" row, every opencode model, no account segment', async () => {
    apiMocks.getEngineLimits.mockResolvedValue({ generatedAt: 'now', default: 'claude', engines: {} })
    renderUi(<Harness initial={{ engine: 'opencode', model: 'opencode-go/glm-5.3' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())
    expect(chip().getAttribute('aria-label')).toBe('Model and effort: opencode · glm-5.3')
    openMenu()
    expect(await screen.findByText(/^Engine · opencode$/)).toBeTruthy()
    expect(modelNames()).toHaveLength(4)
    fireEvent.click(screen.getByRole('menuitem', { name: /switch engine/i }))
    await screen.findByRole('menuitem', { name: /^back$/i })
    expect(engineRows().filter((r) => r.startsWith('opencode'))).toEqual(['opencode'])
  })

  it('is unchanged when the limits read fails', async () => {
    apiMocks.getEngineLimits.mockRejectedValue(new Error('boom'))
    renderUi(<Harness initial={{ engine: 'claude', model: 'opus' }} />)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())
    await openEnginePanel()
    expect(engineRows().filter((r) => r.startsWith('opencode'))).toEqual(['opencode'])
  })
})

describe('the fallback chip\'s picker', () => {
  function renderPicker(onChoose: (c: { engine: string; model: string }) => void, own?: { engine: string; model: string }) {
    const view: SessionFallbackView = { mode: 'fallback', modeSource: 'session', target: own ? { ...own, label: own.model } : null, targetSource: own ? 'session' : 'config', allowedEngines: ['claude', 'opencode'] }
    return renderUi(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent><FallbackTargetPicker view={view} onChoose={onChoose} onBack={() => {}} /></DropdownMenuContent>
      </DropdownMenu>,
    )
  }

  it('lists the same per-account rows, and a model pick under an account names that account\'s provider', async () => {
    const onChoose = vi.fn()
    renderPicker(onChoose)
    await waitFor(() => expect(apiMocks.getEngineLimits).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    await waitFor(() => expect(engineRows()).toContain('opencode · go-b'))
    expect(engineRows()).toContain('opencode · go-a')
    expect(engineRows()).not.toContain('opencode')
    fireEvent.click(screen.getByRole('menuitem', { name: 'opencode · go-b' }))
    expect(await screen.findByText(/Engine · opencode · go-b/)).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^kimi-k3/ }))
    expect(onChoose).toHaveBeenCalledWith({ engine: 'opencode', model: 'opencode-go-b/kimi-k3' })
  })

  it('starts on the account of the session\'s own target', async () => {
    renderPicker(() => {}, { engine: 'opencode', model: 'opencode-go-b/glm-5.3' })
    expect(await screen.findByText(/Engine · opencode · go-b/)).toBeTruthy()
  })

  it('is the single "opencode" row with no accounts declared', async () => {
    apiMocks.getEngineLimits.mockResolvedValue({ generatedAt: 'now', default: 'claude', engines: {} })
    renderPicker(() => {})
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    expect(engineRows().filter((r) => r.startsWith('opencode'))).toEqual(['opencode'])
  })
})
