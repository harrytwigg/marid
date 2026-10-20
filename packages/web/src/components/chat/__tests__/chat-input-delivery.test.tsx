import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../chat-input'
import { SEND_DELIVERY_STORAGE_KEY } from '../send-delivery'

vi.mock('@/hooks/use-employees', () => { const data = { employees: [] }; return { useOrg: () => ({ data }) } })
vi.mock('@/hooks/use-skills', () => { const data: never[] = []; const refetch = vi.fn(); return { useSkills: () => ({ data, refetch }) } })
vi.mock('@/hooks/use-stt', () => ({ useStt: () => ({ state: 'idle', languages: ['en'], selectedLanguage: 'en' }) }))
vi.mock('@/components/stt/whisper-download-modal', () => ({ WhisperDownloadModal: () => null }))

const props = { disabled: false, loading: true, onNewSession: vi.fn(), onStatusRequest: vi.fn() }

beforeEach(() => { sessionStorage.clear(); localStorage.clear() })

function typeAndEnter(text: string, init: KeyboardEventInit = {}) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ...init })
}

describe('composer delivery choice while a turn runs', () => {
  it('queues by default: Enter sends with interrupt off', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Queue' }).getAttribute('aria-pressed')).toBe('true')

    typeAndEnter('wait for it')

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('wait for it', undefined, false, false))
  })

  it('send-now interrupts, and the choice is remembered', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const first = render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(localStorage.getItem(SEND_DELIVERY_STORAGE_KEY)).toBe('now')

    typeAndEnter('do this instead')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('do this instead', undefined, true, false))
    first.unmount()

    render(<ChatInput {...props} sessionId="s2" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Send now' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('Alt+Enter flips the standing choice for one send', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)

    typeAndEnter('just this once', { altKey: true })

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('just this once', undefined, true, false))
    expect(screen.getByRole('button', { name: 'Queue' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('the placeholder says what Enter will do', () => {
    render(<ChatInput {...props} sessionId="s1" onSend={vi.fn()} />)
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toMatch(/queue/i)

    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))

    expect(screen.getByRole('textbox').getAttribute('placeholder')).toMatch(/interrupt/i)
    expect(screen.getByRole('textbox').getAttribute('placeholder')).not.toMatch(/queue/i)
  })

  it('shows no delivery choice when no turn is running', () => {
    render(<ChatInput {...props} loading={false} sessionId="s1" onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
  })
})
