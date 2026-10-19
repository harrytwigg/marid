import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { scrollTranscriptTo, takeTranscriptWriteTop, useTranscriptVirtualizer } from '../transcript-virtualizer'
import { fakeScroller, SCROLLER_HEIGHT } from './fake-scroller'
import type { RenderGroup } from '../chat-messages'

/**
 * Who is allowed to move the transcript scroller.
 *
 * The virtualizer keeps re-issuing a `scrollToIndex` from its own rAF until the
 * target holds still. Those retries land after the reader has been shown the
 * frame they correct, which is the jump this suite is about, so the open path must
 * not leave any of them able to write.
 */

const COUNT = 60

function fakeGroups(): RenderGroup[] {
  return Array.from({ length: COUNT }, () => ({ kind: 'plain', item: { kind: 'message' } })) as RenderGroup[]
}

describe('the transcript scroller takes our writes and not the virtualizer\'s retries', () => {
  let frames: FrameRequestCallback[] = []

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('writes once for a scroll to the end, and nothing from the frames after it', () => {
    let scrollHeight = 4000
    const { el, scrollTo } = fakeScroller(() => scrollHeight)
    const groups = fakeGroups()
    const keys = groups.map((_, index) => `g${index}`)
    const { result } = renderHook(() => useTranscriptVirtualizer(groups, keys, true, () => el as HTMLDivElement, 0))

    act(() => { result.current.getTotalSize() })
    act(() => {
      scrollTranscriptTo(result.current, (v) => v.scrollToIndex(COUNT - 1, { align: 'end' }))
    })

    // The end of a virtualised transcript is the scroller's own clamped maximum.
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 4000 - SCROLLER_HEIGHT }))

    // A late row measurement moves that maximum. The virtualizer's reconcile frame
    // sees it and wants to chase it; re-targeting before paint is the settle
    // window's job, and a write from here would arrive a frame too late to be one.
    scrollHeight = 5200
    act(() => { frames.splice(0).forEach((frame) => frame(0)) })

    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(el.scrollTop).toBe(4000 - SCROLLER_HEIGHT)
  })

  it('reports where a write left the scroller, once', () => {
    const { el } = fakeScroller(() => 4000)
    const groups = fakeGroups()
    const keys = groups.map((_, index) => `g${index}`)
    const { result } = renderHook(() => useTranscriptVirtualizer(groups, keys, true, () => el as HTMLDivElement, 0))
    act(() => { result.current.getTotalSize() })

    expect(takeTranscriptWriteTop(result.current)).toBeUndefined()
    act(() => {
      scrollTranscriptTo(result.current, (v) => v.scrollToIndex(COUNT - 1, { align: 'end' }))
    })

    // The scroll event that write produces is the one it answers for; a later
    // scroll landing on the same pixel is the reader, and must read as theirs.
    expect(takeTranscriptWriteTop(result.current)).toBe(4000 - SCROLLER_HEIGHT)
    expect(takeTranscriptWriteTop(result.current)).toBeUndefined()
  })
})
