/**
 * The chat route's pane slot, with everything around it stripped away, plus the
 * frame recorder the open-continuity suite counts off.
 *
 * The wiring is real — usePaneIdentity, which owns the commit lag, plus
 * useLiveSession and useHydrationSpinner — with only the transport faked by the
 * importing suite. The spinner predicate is copied from chat-pane.tsx (search
 * `showSessionHydration`): the one line this harness restates, and it has to
 * stay in step.
 */
import { startTransition, useEffect, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import { sessionBackedPaneIdentity, usePaneIdentity } from '../pane-identity'
import { useHydrationSpinner, useRouteLoadingPresence } from '@/components/chat/chat-hydration'
import { useLiveSession } from '@/hooks/use-live-session'
import type { GatewayEventListener } from '@hundredfold/gateway-events'

/** One committed paint of the pane the reader can see. A frame only exists when
 *  something is mounted and on screen, so an absent frame IS the withheld mount
 *  — or, on a phone, the pane slot hidden behind the chat list. */
export interface Frame {
  sessionId: string | null
  content: boolean
  spinner: boolean
}

export const SPINNER_THRESHOLD_MS = 250
/** Slower than the spinner threshold: a cold open genuinely shows its spinner. */
export const SLOW_MS = 400
/** Quick enough that a switch warms its destination in a beat. */
export const FAST_MS = 100
/** Long enough that a stalled destination would have shown a spinner by now. */
export const PAST_ANY_THRESHOLD_MS = 1_000

export const frames: Frame[] = []

export function resetFrames() {
  frames.length = 0
}

const paneEventListeners = new Set<GatewayEventListener>()

function subscribe(listener: GatewayEventListener) {
  paneEventListeners.add(listener)
  return () => { paneEventListeners.delete(listener) }
}

export function emitPaneEvent(frame: Parameters<GatewayEventListener>[0]) {
  paneEventListeners.forEach((listener) => listener(frame))
}

export function resetPaneEvents() {
  paneEventListeners.clear()
}

export function transcript(id: string, rows: number) {
  return Array.from({ length: rows }, (_, i) => ({
    id: `${id}-m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${id} row ${i}`,
    timestamp: 1_000 + i,
  }))
}

function Pane({
  sessionId,
  onScreen = true,
  observable = false,
}: {
  sessionId: string | null
  onScreen?: boolean
  observable?: boolean
}) {
  const { messages, hydrating, streamingText } = useLiveSession(sessionId, { subscribe })
  const spinner = useHydrationSpinner(Boolean(sessionId && hydrating && messages.length === 0 && !streamingText))
  useEffect(() => {
    if (onScreen) frames.push({ sessionId, content: messages.length > 0, spinner })
  })
  if (!observable || !sessionId) return null
  return (
    <output
      data-testid={`pane-${sessionId}`}
      data-messages={JSON.stringify(messages)}
      data-stream={streamingText}
    />
  )
}

/** The real live-session wiring for arbitrary session-backed panes. Keys come
 * from pane identity rather than array position, so sibling removal cannot
 * replace a streaming hook instance. */
export function MultiPaneSurface({ sessionIds }: { sessionIds: string[] }) {
  return sessionIds.map((sessionId) => {
    const identity = sessionBackedPaneIdentity(sessionId)
    return <Pane key={identity.paneKey} sessionId={identity.sessionId} observable />
  })
}

interface SurfaceProps {
  selectedId: string | null
  sessionsPending?: boolean
  sessionCount?: number
  newChatIntent?: boolean
}

export function Surface({ selectedId, sessionsPending = false, sessionCount = 0, newChatIntent = false }: SurfaceProps) {
  const { paneKey, committedId, awaitingOpen } = usePaneIdentity(selectedId, null, {
    newChatIntent,
    sessionsPending,
    sessionCount,
  })
  if (awaitingOpen) return null
  return <Pane key={paneKey} sessionId={committedId} />
}

/** jsdom lays nothing out, so the one measurement the route takes off the pane
 *  slot is supplied here: a slot the phone has display-toggled away is zero
 *  high, and a slot on screen is not. */
function useSlotHeight(slotRef: RefObject<HTMLDivElement | null>, onScreen: boolean) {
  useLayoutEffect(() => {
    if (slotRef.current) {
      Object.defineProperty(slotRef.current, 'clientHeight', { configurable: true, value: onScreen ? 640 : 0 })
    }
  }, [slotRef, onScreen])
}

interface PhoneSurfaceProps {
  /** The chat the URL already names, or null to start on the list. */
  initialSelectedId: string | null
  /** The rows the chat list offers. */
  rows: string[]
}

/**
 * The phone layout, where the pane slot is a screen rather than a column.
 *
 * The route hides the slot with a class while the chat list is up, so the pane
 * inside it stays mounted on the session the reader last read. Tapping a row
 * reveals that slot in the same urgent paint, while the URL behind it lands a
 * transition later — which is the disagreement this surface exists to expose,
 * and the reason a desktop-shaped harness measured this open as clean.
 */
export function PhoneSurface({ initialSelectedId, rows }: PhoneSurfaceProps) {
  const [selectedId, setSelectedId] = useState(initialSelectedId)
  const [newChatIntent, setNewChatIntent] = useState(false)
  const [onList, setOnList] = useState(initialSelectedId === null)
  const { paneKey, committedId, awaitingOpen, paneSlotRef, revealSelection } = usePaneIdentity(selectedId, null, {
    newChatIntent,
    sessionsPending: false,
    sessionCount: rows.length,
  })
  useSlotHeight(paneSlotRef, !onList)
  const openChat = (id: string) => {
    // handleSelect's order: the reveal is urgent and paints at once, while the
    // navigation behind it is a react-router transition and lands a frame later.
    revealSelection(id)
    setOnList(false)
    startTransition(() => setSelectedId(id))
  }
  return (
    <>
      {rows.map((id) => (
        <button key={id} data-testid={`row-${id}`} onClick={() => openChat(id)} />
      ))}
      {/* The back chip pops the thread without touching the URL; browser back
          lands on the bare `/` the list was opened from, which is where the
          route arms the new-chat intent so the auto-select cannot hijack it. */}
      <button data-testid="back" onClick={() => setOnList(true)} />
      <button
        data-testid="pop-to-list"
        onClick={() => {
          setOnList(true)
          setNewChatIntent(true)
          startTransition(() => setSelectedId(null))
        }}
      />
      <div ref={paneSlotRef}>
        {awaitingOpen ? null : <Pane key={paneKey} sessionId={committedId} onScreen={!onList} />}
      </div>
    </>
  )
}

/** The route-level fallback a cold direct open waits at before the chat chunk
 *  lands. It records frames too, so a handoff to the pane is counted as part of
 *  the same open rather than as something that happened before it. */
function RouteFallback() {
  useRouteLoadingPresence()
  useEffect(() => {
    frames.push({ sessionId: null, content: false, spinner: true })
  })
  return null
}

/** A cold direct open: the route fallback until the chat chunk resolves, then
 *  the pane, exactly as the Suspense boundary in main.tsx swaps them. */
export function ColdDirectOpen({ selectedId, chunkLoaded }: { selectedId: string; chunkLoaded: boolean }) {
  return chunkLoaded ? <Surface selectedId={selectedId} sessionCount={3} /> : <RouteFallback />
}

/** Number of times a spinner appeared — a run of spinner frames counts once. */
export function loadingStates(recorded: Frame[]): number {
  let count = 0
  recorded.forEach((frame, i) => {
    if (frame.spinner && !recorded[i - 1]?.spinner) count += 1
  })
  return count
}

/** The defect this ticket exists for: content on screen, then a spinner over it. */
export function spinnerAfterContent(recorded: Frame[]): boolean {
  const firstContent = recorded.findIndex((frame) => frame.content)
  return firstContent >= 0 && recorded.slice(firstContent).some((frame) => frame.spinner)
}

/** One jump of the fake clock coalesces every state update it triggers into a
 *  single React commit, which would hide the very frames this suite counts.
 *  Stepping in slices lets React commit between timers, the way real frames do. */
export async function advance(ms: number) {
  for (let remaining = ms; remaining > 0; remaining -= 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(50, remaining)) })
  }
}
