import "@/test/preload-menus"
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { EnginesResponse } from '@/lib/api'
import { FallbackModeChip } from '../fallback-mode-chip'
import type { SessionFallbackView } from '../fallback-mode-model'

/** The fallback chip's "Choose fallback model…" panel: the new-chat model picker, used pick-only. */

const apiMocks = vi.hoisted(() => ({ updateSession: vi.fn(), getSession: vi.fn(), refreshEngines: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const model = (id: string, label = id) => ({ id, label, supportsEffort: false, effortLevels: [] })
const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: { name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag', models: [model('opus', 'Opus'), model('sonnet', 'Sonnet')] },
    codex: { name: 'codex', available: true, defaultModel: 'gpt-5.5', effortMechanism: 'codex-config', models: [model('gpt-5.5', 'GPT-5.5'), model('gpt-mini', 'GPT Mini')] },
    opencode: {
      name: 'opencode', available: true, defaultModel: 'openai/gpt-6', effortMechanism: 'none',
      models: ['openai/gpt-6', 'openai/gpt-7', 'opencode-go/glm-5.3', 'opencode-go/kimi-k3', 'opencode-go/qwen3.8-max', 'opencode-go/minimax-m3', 'opencode-go/grok-4.7'].map((id) => model(id, id.slice(id.indexOf('/') + 1))),
    },
    pi: { name: 'pi', available: false, defaultModel: 'p', effortMechanism: 'none', models: [model('p')] },
  },
}
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})

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
  apiMocks.updateSession.mockReset()
  apiMocks.updateSession.mockResolvedValue({})
})

const configTarget = { engine: 'opencode', model: 'openai/gpt-6', label: 'gpt-6' }
const view = (over: Partial<SessionFallbackView> = {}): SessionFallbackView => ({
  mode: 'fallback', modeSource: 'session', target: configTarget, targetSource: 'config', allowedEngines: ['claude', 'codex', 'opencode'], ...over,
})
const ownView = (over: Partial<SessionFallbackView> = {}) =>
  view({ targetSource: 'session', target: { engine: 'codex', model: 'gpt-mini', label: 'GPT Mini' }, ...over })

function renderChip(v: SessionFallbackView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui: ReactElement = <QueryClientProvider client={client}><FallbackModeChip sessionId="s1" view={v} /></QueryClientProvider>
  return render(ui)
}
const chipText = () => screen.getByTestId('fallback-mode-chip').textContent
function openMenu() { fireEvent.keyDown(screen.getByTestId('fallback-mode-chip'), { key: 'Enter' }) }
async function openPicker() {
  openMenu()
  fireEvent.click(await screen.findByRole('menuitem', { name: /choose fallback model/i }))
}

describe('the chip menu', () => {
  it('offers "Choose fallback model…", and "Use config fallback" only while the session has its own target', () => {
    renderChip(view())
    openMenu()
    expect(screen.getByRole('menuitem', { name: /choose fallback model/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /use config fallback/i })).toBeNull()
  })

  it('shows "Use config fallback" for a session target, and clears it', async () => {
    apiMocks.updateSession.mockResolvedValue({ fallback: view() })
    renderChip(ownView())
    expect(chipText()).toContain('Fallback: GPT Mini')
    openMenu()
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /use config fallback/i })) })
    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', { fallbackTarget: null })
    await waitFor(() => expect(chipText()).toContain('Fallback: gpt-6'))
  })
})

describe('the fallback model picker', () => {
  it('is the new-chat picker: engine header, search box and model list, with a way back', async () => {
    renderChip(view())
    await openPicker()
    expect(await screen.findByLabelText('Search models')).toBeTruthy()
    expect(screen.getByText(/Engine · Claude/)).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Opus' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /^back$/i }))
    expect(await screen.findByRole('menuitemradio', { name: /fall back on usage limit/i })).toBeTruthy()
  })

  it('starts on the session\'s own target engine and marks its model', async () => {
    renderChip(ownView())
    await openPicker()
    expect(await screen.findByText(/Engine · Codex/)).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'GPT Mini' }).getAttribute('aria-checked')).toBe('true')
  })

  it('searches the whole catalog of the browsed engine', async () => {
    renderChip(ownView({ target: { engine: 'opencode', model: 'openai/gpt-6', label: 'gpt-6' } }))
    await openPicker()
    fireEvent.change(await screen.findByLabelText('Search models'), { target: { value: 'minimax' } })
    expect(screen.getByRole('menuitemradio', { name: /minimax-m3/ })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /^gpt-7/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'zzz' } })
    expect(screen.getByText(/no models match/i)).toBeTruthy()
  })

  it('browsing another engine changes nothing; picking a model sends exactly that engine and model and closes', async () => {
    apiMocks.updateSession.mockResolvedValue({ fallback: ownView() })
    renderChip(view())
    await openPicker()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /codex/i }))
    expect(apiMocks.updateSession).not.toHaveBeenCalled()
    expect(await screen.findByText(/Engine · Codex/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT Mini' })) })
    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', { fallbackTarget: { engine: 'codex', model: 'gpt-mini' } })
    await waitFor(() => expect(chipText()).toContain('Fallback: GPT Mini'))
    expect(screen.queryByLabelText('Search models')).toBeNull()
  })

  it('offers only the engines the session may use: installed and allowed', async () => {
    renderChip(view({ allowedEngines: ['claude', 'codex'] }))
    await openPicker()
    fireEvent.click(await screen.findByRole('menuitem', { name: /switch engine/i }))
    expect(await screen.findByRole('menuitem', { name: /codex/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /claude/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /opencode/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^pi$/i })).toBeNull()
  })

  it('a scoped session (claude only) has no engine switch', async () => {
    renderChip(view({ allowedEngines: ['claude'] }))
    await openPicker()
    expect(await screen.findByText(/Engine · Claude/)).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /switch engine/i })).toBeNull()
  })

  it('a refusal goes back to the list and shows the reason, leaving the chip as it was', async () => {
    apiMocks.updateSession.mockRejectedValue(new Error('fallbackTarget refused: engine "codex" is not installed'))
    renderChip(view())
    await openPicker()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sonnet' }))
    expect((await screen.findByRole('alert')).textContent).toContain('not installed')
    expect(chipText()).toContain('Fallback: gpt-6')
  })
})
