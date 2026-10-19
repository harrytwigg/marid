import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { installVirtualLayout } from './virtual-layout'
import type { Message } from '@/lib/conversations'

const stickState = {
  showJump: true,
  unreadCount: 0,
  scrollToBottom: vi.fn(),
  /** The affordance's own behaviour is stubbed; where it SCROLLS TO is not. */
  real: false,
}

vi.mock('@/hooks/use-stick-to-bottom', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-stick-to-bottom')>('@/hooks/use-stick-to-bottom')
  return {
    ...actual,
    useStickToBottom: (options: Parameters<typeof actual.useStickToBottom>[0]) =>
      stickState.real ? actual.useStickToBottom(options) : {
        containerRef: vi.fn(),
        showJump: stickState.showJump,
        unreadCount: stickState.unreadCount,
        scrollToBottom: stickState.scrollToBottom,
      },
  }
})

const messages: Message[] = [{
  id: 'm1',
  role: 'assistant',
  content: 'Latest answer',
  timestamp: 100,
}]

afterEach(() => {
  stickState.showJump = true
  stickState.unreadCount = 0
  stickState.real = false
  stickState.scrollToBottom.mockReset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ChatMessages jump affordance', () => {
  it('pins the jump control to the visible scrollport instead of the scrollable transcript', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: /jump to latest/i })
    const scroller = document.querySelector('.chat-messages-scroll')
    expect(scroller).toBeTruthy()
    expect(scroller?.contains(jump)).toBe(false)
  })

  it('uses an icon-only visible action with the label kept for accessibility', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(within(jump).queryByText(/jump to latest/i)).toBeNull()
  })

  it('is floating glass and rides above the composer that overlaps the transcript', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(jump.classList.contains('glass-float')).toBe(true)
    expect(jump.className).not.toMatch(/backdrop-blur/)
    expect(jump.className).toContain('var(--composer-overlap,0px)')
  })

  it('pads the transcript by the composer overlap, which is 0 wherever the composer does not float', () => {
    const { container } = render(<ChatMessages messages={messages} loading={false} />)

    const column = container.querySelector('.chat-messages-scroll > div')!
    expect(column.className).toContain('var(--composer-overlap,0px)')
  })

  it('keeps the touch affordance at 40px and shrinks only for fine pointers', () => {
    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: 'Jump to latest' })
    expect(jump.className).toContain('h-10')
    expect(jump.className).toContain('w-10')
    expect(jump.className).toContain('[@media(pointer:fine)]:h-9')
    expect(jump.className).toContain('[@media(pointer:fine)]:w-9')
  })

  it('shows only a compact numeric unread badge when detached messages accumulate', () => {
    stickState.unreadCount = 3

    render(<ChatMessages messages={messages} loading={false} />)

    const jump = screen.getByRole('button', { name: /3 new messages/i })
    const badge = within(jump).getByText('3')
    expect(badge.className).toContain('absolute')
    expect(within(jump).queryByText(/new messages/i)).toBeNull()
  })

  it('keeps the jump control mounted briefly for an exit animation', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy()

    stickState.showJump = false
    rerender(<ChatMessages messages={messages} loading={false} />)

    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    const exiting = document.querySelector('[data-state="exiting"]') as HTMLButtonElement | null
    expect(exiting).toBeTruthy()
    expect(exiting?.getAttribute('aria-hidden')).toBe('true')
    expect(exiting?.getAttribute('tabindex')).toBe('-1')

    act(() => { vi.runAllTimers() })
    expect(document.querySelector('[data-state="exiting"]')).toBeNull()
  })
})

describe('ChatMessages jump on a virtualised thread', () => {
  const ROW_H = 140
  const VIEWPORT_H = 700
  const longThread: Message[] = Array.from({ length: 500 }, (_, i) => ({
    id: `v${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: `message ${i}`,
    timestamp: 1_700_000_000_000 + i * 1000,
  }))

  // The hook coalesces its affordance state into a frame, so let one pass.
  const nextFrame = () => act(async () => { await new Promise((done) => setTimeout(done, 20)) })

  it('appears when detached and lands at the true bottom', async () => {
    stickState.real = true
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H)
    render(<ChatMessages messages={longThread} loading={false} />)

    // Read up: the affordance appears and the last message is nowhere near.
    act(() => { layout.scrollTo(2_000) })
    await nextFrame()
    expect(layout.visibleMessageIds()).not.toContain('v499')
    const jump = screen.getByRole('button', { name: /jump to latest/i })

    act(() => { fireEvent.click(jump) })
    await nextFrame()

    // The bottom of a virtualised thread is not `scrollHeight` until the last
    // row has measured; the jump has to arrive there anyway.
    expect(layout.visibleMessageIds()).toContain('v499')
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull()
    layout.release()
  })
})

describe('ChatMessages older history loading', () => {
  it('loads older messages automatically near the top without exposing a top button', () => {
    const onLoadOlderMessages = vi.fn()
    render(
      <ChatMessages
        messages={messages}
        loading={false}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    const scroller = document.querySelector('.chat-messages-scroll') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollTop', { value: 120, writable: true, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true })

    fireEvent.scroll(scroller)

    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /load older/i })).toBeNull()
  })

  it('preserves the visible message position when older messages are prepended', () => {
    const rects = new Map<string, { top: number; bottom: number }>()
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('chat-messages-scroll')) {
        return { top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) }
      }
      const id = this.getAttribute('data-message-id')
      const rect = id ? rects.get(id) : null
      if (rect) {
        return { ...rect, left: 0, right: 500, width: 500, height: rect.bottom - rect.top, x: 0, y: rect.top, toJSON: () => ({}) }
      }
      return { top: 900, bottom: 940, left: 0, right: 500, width: 500, height: 40, x: 0, y: 900, toJSON: () => ({}) }
    })
    const onLoadOlderMessages = vi.fn()
    const initial: Message[] = [
      { id: 'm3', role: 'assistant', content: 'three', timestamp: 3 },
      { id: 'm4', role: 'assistant', content: 'four', timestamp: 4 },
    ]
    const older: Message[] = [
      { id: 'm1', role: 'assistant', content: 'one', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'two', timestamp: 2 },
      ...initial,
    ]
    rects.set('m3', { top: 40, bottom: 90 })
    const { rerender } = render(
      <ChatMessages
        messages={initial}
        loading={false}
        hasOlderMessages
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    const scroller = document.querySelector('.chat-messages-scroll') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollTop', { value: 120, writable: true, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true })

    fireEvent.scroll(scroller)

    rects.set('m3', { top: 640, bottom: 690 })
    Object.defineProperty(scroller, 'scrollHeight', { value: 2600, writable: true, configurable: true })
    rerender(
      <ChatMessages
        messages={older}
        loading={false}
        hasOlderMessages={false}
        onLoadOlderMessages={onLoadOlderMessages}
      />,
    )

    expect(scroller.scrollTop).toBe(720)
    rectSpy.mockRestore()
  })
})
