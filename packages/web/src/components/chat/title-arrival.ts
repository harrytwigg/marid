import { useEffect, useMemo, useRef } from 'react'
import { arrivesByTabSwitch } from './tab-switch-mark'

/** The entrance (--duration-base) plus a paint. The mark belongs to the commit
 *  that swaps the title, not to the title, so it is dropped again afterwards. */
const ENTER_MARK_TTL_MS = 1_000

/** Read live on the commit that would mark, like the transcript's arrivals: a
 *  setting changed mid-session takes effect on the next title, no listener. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * True on the commit that replaces one conversation title with another in front
 * of the reader.
 *
 * The title a header mounts with is never marked — it did not arrive, it was
 * already there. Neither is one that changed while `showing` was false: the
 * working-set chips were standing in its place, so putting the span back is a
 * mount too. A remount, an unrelated rerender, and a change nobody could see
 * all animate nothing — and neither does any title of a chat a tab press brought
 * forward, which moves between chats that are already open and is not an arrival.
 */
export function useTitleArrival(title: string, showing: boolean, chatId?: string | null): boolean {
  const seenRef = useRef<string | null>(null)
  const enteringRef = useRef(false)
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dropMark = () => {
    enteringRef.current = false
    if (expiryRef.current !== null) clearTimeout(expiryRef.current)
    expiryRef.current = null
  }

  // Mutated during render, deliberately: the mark has to reach the very commit
  // that paints the new title, or the entrance it describes is already over.
  useMemo(() => {
    // A mark belongs to one continuous life of the span. The moment the title
    // leaves the bar the entrance it described is over, so the mark goes with
    // it — otherwise the span the chips hand back mounts already carrying it.
    if (!showing) dropMark()
    const seen = seenRef.current
    if (seen === null) return
    // Recorded even while hidden, so a swap behind the chips is already old news
    // by the time the span comes back rather than reading as a fresh arrival.
    seenRef.current = title
    if (!showing || seen === title || prefersReducedMotion() || arrivesByTabSwitch(chatId)) return
    enteringRef.current = true
    expiryRef.current = setTimeout(dropMark, ENTER_MARK_TTL_MS)
  }, [title, showing])

  useEffect(() => {
    if (seenRef.current === null) seenRef.current = title
  }, [title])

  return enteringRef.current
}
