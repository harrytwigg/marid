import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from '../chat-input'

vi.mock('@/hooks/use-employees', () => { const data = { employees: [] }; return { useOrg: () => ({ data }) } })
vi.mock('@/hooks/use-skills', () => { const data: never[] = []; const refetch = vi.fn(); return { useSkills: () => ({ data, refetch }) } })
vi.mock('@/hooks/use-stt', () => ({ useStt: () => ({ state: 'idle', languages: ['en'], selectedLanguage: 'en' }) }))
vi.mock('@/components/stt/whisper-download-modal', () => ({ WhisperDownloadModal: () => null }))

const props = { disabled: false, loading: false, onNewSession: vi.fn(), onStatusRequest: vi.fn() }

function setPointer(kind: 'coarse' | 'fine') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: kind === 'coarse' && query === '(pointer: coarse)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
}

/** Press a key in the composer; returns whether the browser default was left alone. */
function press(init: KeyboardEventInit & { keyCode?: number }) {
  const box = screen.getByRole('textbox')
  const event = createEvent.keyDown(box, { key: 'Enter', ...init })
  fireEvent(box, event)
  return !event.defaultPrevented
}

function draft(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
}

beforeEach(() => { sessionStorage.clear(); localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('composer Enter key', () => {
  it('fine pointer: Enter sends and is swallowed', async () => {
    setPointer('fine')
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    draft('hello')

    expect(press({})).toBe(false)

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0]).toBe('hello')
  })

  it('fine pointer: Shift+Enter is left to insert a newline', () => {
    setPointer('fine')
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    draft('hello')

    expect(press({ shiftKey: true })).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('coarse pointer: Enter is left to insert a newline and never sends', async () => {
    setPointer('coarse')
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    draft('hello')

    expect(press({})).toBe(true)
    expect(press({ altKey: true })).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onSend).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('coarse pointer: the Send button still sends', async () => {
    setPointer('coarse')
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    draft('hello')

    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0]).toBe('hello')
  })

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('IME composition (%s): Enter neither sends nor is swallowed', async (_name, init) => {
    setPointer('fine')
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput {...props} sessionId="s1" onSend={onSend} />)
    draft('こんにちは')

    expect(press(init)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(onSend).not.toHaveBeenCalled()
  })
})
