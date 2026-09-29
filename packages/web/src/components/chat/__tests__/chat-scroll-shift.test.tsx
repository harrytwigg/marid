import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'
import { installVirtualLayout } from './virtual-layout'

/**
 * What moves under a reader who only scrolled.
 *
 * `chat-scroll-anchor.test.tsx` covers the prepend. These are the three ways a
 * windowed transcript moves without one: a row that measures differently when
 * it comes back into the window, a row the virtualizer takes for one above the
 * reader when it is not, and a row mounting above the whole virtual block.
 *
 * Every message is a user message on purpose: user rows never fold and never
 * group, so one message is one virtual row. `ROW_H` matches the virtualizer's
 * resting estimate for one, so nothing re-measures except what a test moves.
 */

const ROW_H = 140
const VIEWPORT_H = 700
const COUNT = 120
/** The transcript's own `--chat-header-band` at lg (88px) — the gap the virtual block starts below. */
const HEADER_PAD = 88
/** Each of the older-page states is one `h-8` row above the block. */
const OLDER_ROW_H = 32

interface CapturedObserver { cb: ResizeObserverCallback; observed: Element[] }

/** What a browser hands a ResizeObserver callback. */
const resized = (target: Element) => (
  [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry]
)

/** Capture every ResizeObserver, delivering on `observe` as the suite's default
 *  stub does — the virtualizer measures through one of these too. */
function captureResizeObservers(): CapturedObserver[] {
  const instances: CapturedObserver[] = []
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback
    observed: Element[] = []
    constructor(cb: ResizeObserverCallback) { this.cb = cb; instances.push(this) }
    observe(target: Element) {
      this.observed.push(target)
      this.cb(resized(target), this as unknown as ResizeObserver)
    }
    unobserve(target: Element) { this.observed = this.observed.filter((el) => el !== target) }
    disconnect() {}
  })
  return instances
}

const rowObserverOf = (observers: CapturedObserver[]) => (
  observers.find((observer) => observer.observed.some((el) => el.hasAttribute('data-index')))!
)

const remeasure = (observers: CapturedObserver[], row: Element) => {
  const observer = rowObserverOf(observers)
  act(() => { observer.cb(resized(row), observer as unknown as ResizeObserver) })
}

const rowOf = (messageId: string) => (
  document.querySelector(`.chat-messages-scroll [data-message-id="${messageId}"]`)!.closest('[data-index]')!
)

/** What sits above the virtual block: the header padding, plus each of the
 *  older-page rows the transcript renders in front of it. */
function blockOffset(): number {
  const block = document.querySelector('.chat-messages-scroll [data-index]')?.parentElement
  let above = HEADER_PAD
  for (let el = block?.previousElementSibling ?? null; el; el = el.previousElementSibling) above += OLDER_ROW_H
  return above
}

const thread: Message[] = Array.from({ length: COUNT }, (_, index) => ({
  id: `v${index}`,
  role: 'user' as const,
  content: `message ${index}`,
  timestamp: 1_700_000_000_000 + index * 60_000,
}))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('a windowed transcript under a reader who only scrolled', () => {
  /** The paste, and the row directly below it — the one the reader is watching. */
  const PASTE_ID = 'v10'
  const ANCHOR_ID = 'v11'
  /** What the paste measures with nothing clamping it. */
  const PASTE_H = 600
  const READING_TOP = 1_200
  const AWAY_TOP = 6_000

  /** The paste is as tall as its text, bounded by whatever clamp the bubble is
   *  applying right now — an unclamped one reports the whole wall of it. */
  const pasteAwareRowHeight = (row: HTMLElement) => {
    const content = row.querySelector<HTMLElement>(`[data-message-id="${PASTE_ID}"] .user-msg-bubble > div`)
    if (!content) return ROW_H
    const clamp = parseFloat(content.style.maxHeight)
    return Number.isNaN(clamp) ? PASTE_H : Math.min(clamp, PASTE_H)
  }

  /** jsdom lays nothing out, so the bubble has to be told it is a long one. */
  function stubPasteHeight(): void {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const inPaste = this.parentElement?.classList.contains('user-msg-bubble')
        && this.closest(`[data-message-id="${PASTE_ID}"]`) !== null
      return inPaste ? PASTE_H : 0
    })
  }

  it('holds the reader when a collapsed paste comes back into the window', () => {
    const observers = captureResizeObservers()
    stubPasteHeight()
    const layout = installVirtualLayout(pasteAwareRowHeight, VIEWPORT_H, blockOffset)
    render(<ChatMessages messages={thread} loading={false} />)

    // Settle the paste at its resting height first, so what follows is a
    // remount rather than the transcript seeing it for the first time.
    act(() => { layout.scrollTo(READING_TOP) })
    remeasure(observers, rowOf(PASTE_ID))
    const before = layout.offsetOf(ANCHOR_ID)

    act(() => { layout.scrollTo(AWAY_TOP) })
    expect(layout.mountedMessageIds()).not.toContain(PASTE_ID)
    act(() => { layout.scrollTo(READING_TOP) })

    expect(Math.abs(layout.offsetOf(ANCHOR_ID) - before)).toBeLessThanOrEqual(4)
    layout.release()
  })

  it('leaves a row below the scroll position where it is when it grows', () => {
    /** Index 20, so it starts well inside the thread and nowhere near an edge. */
    const GROW_ID = 'v20'
    const GROWN_H = 400
    /** Puts that row's top 10px below the scroll position — visible, and inside
     *  the header-padding band the virtualizer used to read as above it. */
    const READING_TOP = HEADER_PAD + 20 * ROW_H - 10
    let grown = false

    const observers = captureResizeObservers()
    const layout = installVirtualLayout(
      (row) => (row.querySelector(`[data-message-id="${GROW_ID}"]`) && grown ? GROWN_H : ROW_H),
      VIEWPORT_H,
      blockOffset,
    )
    render(<ChatMessages messages={thread} loading={false} />)
    act(() => { layout.scrollTo(READING_TOP) })
    const before = layout.offsetOf(GROW_ID)
    expect(before).toBe(10)

    grown = true
    remeasure(observers, rowOf(GROW_ID))

    expect(Math.abs(layout.offsetOf(GROW_ID) - before)).toBeLessThanOrEqual(4)
    layout.release()
  })

  it('holds the topmost message while the older-page states come and go', () => {
    const pending = () => new Promise<void>(() => {})
    const view = (loading: boolean, error: Error | null) => (
      <ChatMessages
        messages={thread}
        loading={false}
        hasOlderMessages
        loadingOlderMessages={loading}
        olderMessagesError={error}
        onLoadOlderMessages={pending}
      />
    )
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H, blockOffset)
    const { rerender } = render(view(false, null))
    act(() => { layout.scrollTo(3_000) })
    const topId = layout.visibleMessageIds()[0]
    const before = layout.offsetOf(topId)

    for (const [loading, error] of [[true, null], [false, null], [false, new Error('offline')]] as const) {
      act(() => { rerender(view(loading, error)) })
      expect(Math.abs(layout.offsetOf(topId) - before)).toBeLessThanOrEqual(4)
    }
    layout.release()
  })

  // `chat-scroll-anchor.test.tsx` pins the same prepend with the virtual block
  // flush against the scrollport. This one runs it where the block actually
  // sits: below the header padding, below the older-page row.
  it('holds the topmost visible message across an older page that lands below a header', () => {
    const older: Message[] = Array.from({ length: 100 }, (_, k) => ({
      id: `o${k}`,
      role: 'user' as const,
      content: `older ${k}`,
      timestamp: 1_600_000_000_000 + k * 60_000,
    }))
    let page!: () => void
    const promise = new Promise<void>((resolve) => { page = resolve })
    const view = (list: Message[], loading: boolean) => (
      <ChatMessages
        messages={list}
        loading={false}
        hasOlderMessages
        loadingOlderMessages={loading}
        onLoadOlderMessages={() => promise}
      />
    )
    const layout = installVirtualLayout(ROW_H, VIEWPORT_H, blockOffset)
    const { rerender } = render(view(thread, false))

    // Inside OLDER_LOAD_THRESHOLD_PX of the top, which is what asks for the page.
    act(() => { layout.scrollTo(500) })
    act(() => { rerender(view(thread, true)) })
    const topId = layout.visibleMessageIds()[0]
    const before = layout.offsetOf(topId)

    act(() => {
      page()
      rerender(view([...older, ...thread], false))
    })

    expect(layout.mountedMessageIds()).toContain(topId)
    expect(Math.abs(layout.offsetOf(topId) - before)).toBeLessThanOrEqual(4)
    layout.release()
  })
})
