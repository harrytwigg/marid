import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FallbackModeChip } from '../fallback-mode-chip'
import type { SessionFallbackView } from '../fallback-mode-model'

const apiMocks = vi.hoisted(() => ({ updateSession: vi.fn() }))
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
  it('shows disabled for a null target', () => {
    render(<FallbackModeChip sessionId="s1" view={view({ target: null })} />)
    expect(screen.getByTestId('fallback-mode-chip').textContent).toContain('Fallback: disabled')
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
  })
})
