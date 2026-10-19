import "@/test/preload-menus"
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FallbackModeChip } from '../fallback-mode-chip'
import { parseFallbackView, type SessionFallbackView } from '../fallback-mode-model'

const apiMocks = vi.hoisted(() => ({ updateSession: vi.fn(), getSession: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: apiMocks }))

const target = { engine: 'claude', account: 'backup', model: 'sonnet', label: 'Claude backup · Sonnet' }
const view = (over: Partial<SessionFallbackView> = {}): SessionFallbackView => ({
  mode: 'fallback', modeSource: 'session', target, ...over,
})

function open() {
  const chip = screen.getByTestId('fallback-mode-chip')
  fireEvent.keyDown(chip, { key: 'Enter' })
}

beforeEach(() => {
  apiMocks.updateSession.mockReset()
  apiMocks.getSession.mockReset()
  apiMocks.updateSession.mockResolvedValue({})
})

describe('FallbackModeChip labels', () => {
  it('shows the target', () => {
    render(<FallbackModeChip sessionId="s1" view={view()} />)
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('Fallback: Claude backup · Sonnet')
    expect(screen.getByTestId('fallback-mode-chip').getAttribute('title')).toContain('engine claude, account backup, model sonnet')
    expect(screen.queryByTestId('fallback-children-marker')).toBeNull()
  })
  it('shows the children marker', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ mode: 'fallback-children' })} />)
    expect(screen.getByTestId('fallback-children-marker').textContent).toContain('children')
  })
  it('shows none for a session with no fallback target', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ target: null })} />)
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('Fallback: none')
  })
  it('shows none left once the session has walked to the end of its chain', () => {
    const chain = { source: 'account' as const, links: [], position: 3, servedBy: 'opencode||y', next: null, hops: [] }
    render(<FallbackModeChip sessionId="s1" view={view({ target: null, chain })} />)
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('Fallback: none left')
  })
  it('shows off for auto-resume', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ mode: 'auto-resume' })} />)
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('Fallback: off (auto-resume)')
  })
  it('renders nothing without a view', () => {
    const { container } = render(<FallbackModeChip sessionId="s1" view={undefined} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('FallbackModeChip menu', () => {
  it('marks the default and the missing-target note', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ modeSource: 'default', target: null })} />)
    open()
    expect(screen.getByText('(default)')).toBeTruthy()
    expect(screen.getByText('No fallback configured for this model')).toBeTruthy()
    expect(screen.getByText('Never switch model; wait and auto-resume')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /Fall back on usage limit/ }).getAttribute('aria-checked')).toBe('true')
  })
  it('selecting calls updateSession and applies the response view', async () => {
    const next = view({ mode: 'fallback-children' })
    apiMocks.updateSession.mockResolvedValue({ fallback: next })
    render(<FallbackModeChip sessionId="s1" view={view()} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /children/ })) })
    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', { fallbackMode: 'fallback-children' })
    await waitFor(() => expect(screen.getByTestId('fallback-children-marker')).toBeTruthy())
  })
  it('rolls back and shows an error when the update fails', async () => {
    apiMocks.updateSession.mockRejectedValue(new Error('nope'))
    render(<FallbackModeChip sessionId="s1" view={view()} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto-resume/ })) })
    await waitFor(() => expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('Fallback: Claude backup'))
    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', { fallbackMode: 'auto-resume' })
    expect(screen.getByRole('alert').textContent).toBe('nope')
  })
  it('drops a result that arrives after the session changed', async () => {
    let resolve!: (v: unknown) => void
    apiMocks.updateSession.mockReturnValue(new Promise((r) => { resolve = r }))
    const { rerender } = render(<FallbackModeChip sessionId="a" view={view()} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /children/ })) })
    rerender(<FallbackModeChip sessionId="b" view={view({ mode: 'auto-resume' })} />)
    await act(async () => { resolve({ fallback: view({ mode: 'fallback-children' }) }) })
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('off (auto-resume)')
  })
  it('rolls back to what the server last confirmed, not to the view before an earlier pick', async () => {
    let resolveFirst!: (v: unknown) => void
    let rejectSecond!: (e: unknown) => void
    apiMocks.updateSession
      .mockReturnValueOnce(new Promise((r) => { resolveFirst = r }))
      .mockReturnValueOnce(new Promise((_, r) => { rejectSecond = r }))
    render(<FallbackModeChip sessionId="s1" view={view()} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /children/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto-resume/ })) })
    await act(async () => { resolveFirst({ fallback: view({ mode: 'fallback-children' }) }) })
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('off (auto-resume)')
    await act(async () => { rejectSecond(new Error('nope')) })
    await waitFor(() => expect(screen.getByTestId('fallback-children-marker')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toBe('nope')
  })
  it('holds a server view that arrives while a pick is in flight, and applies the pick result', async () => {
    let resolve!: (v: unknown) => void
    apiMocks.updateSession.mockReturnValue(new Promise((r) => { resolve = r }))
    const { rerender } = render(<FallbackModeChip sessionId="s1" view={view()} />)
    open()
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /Auto-resume/ })) })
    rerender(<FallbackModeChip sessionId="s1" view={view({ target: null })} />)
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('off (auto-resume)')
    await act(async () => { resolve({ fallback: view({ mode: 'auto-resume' }) }) })
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('off (auto-resume)')
  })
  it('hides the chip on an unknown view shape', () => {
    const bad = { mode: 'fallback', modeSource: 'session', target: { engine: 'claude' } } as unknown as SessionFallbackView
    const { container } = render(<FallbackModeChip sessionId="s1" view={parseFallbackView(bad)} />)
    expect(container.innerHTML).toBe('')
  })
  it('re-reads the view on session:updated for this session only', async () => {
    let fire!: (f: unknown) => void
    const subscribe = (fn: (f: never) => void) => { fire = fn as (f: unknown) => void; return () => {} }
    apiMocks.getSession.mockResolvedValue({ fallback: view({ mode: 'auto-resume' }) })
    render(<FallbackModeChip sessionId="s1" view={view()} subscribe={subscribe} />)
    await act(async () => { fire({ event: 'session:updated', payload: { sessionId: 'other' } }) })
    expect(apiMocks.getSession).not.toHaveBeenCalled()
    await act(async () => { fire({ event: 'session:updated', payload: { sessionId: 's1' } }) })
    await waitFor(() => expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('off (auto-resume)'))
  })
})
