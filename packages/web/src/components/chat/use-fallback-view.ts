import { useEffect, useRef, useState } from 'react'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { api } from '@/lib/api'
import {
  parseFallbackView,
  withMode,
  withTarget,
  type FallbackTargetChoice,
  type SessionFallbackMode,
  type SessionFallbackView,
} from './fallback-mode-model'

export type FallbackSubscribe = (fn: GatewayEventListener) => () => void

export type FallbackChange = { fallbackMode?: SessionFallbackMode; fallbackTarget?: FallbackTargetChoice | null }

/** Where a change goes: the session's own PUT by default; a new chat keeps it until the session is created. */
export type FallbackSave = (change: FallbackChange) => Promise<{ fallback?: unknown } | undefined | void>

/** Re-read the view when the gateway says this session changed, dropping a read that lands after a session switch. */
function useFallbackResync(
  sessionId: string,
  subscribe: FallbackSubscribe | undefined,
  gen: { current: number },
  accept: (next: SessionFallbackView | null) => void,
) {
  useEffect(() => {
    if (!subscribe) return
    return subscribe((frame) => {
      if (frame.event !== 'session:updated' || frame.payload.sessionId !== sessionId) return
      const mine = gen.current
      api.getSession(sessionId, { messages: false })
        .then((s) => { if (gen.current === mine) accept(parseFallbackView(s.fallback)) })
        .catch(() => {})
    })
    // `accept` only touches refs and a state setter, so a stale copy behaves the same.
  }, [subscribe, sessionId])
}

/**
 * The chip's copy of the session's fallback view, kept in step with the server: a fresh
 * server view replaces it unless a change is in flight, and a session switch discards any
 * result still on its way for the old session.
 */
function useFallbackView(sessionId: string, view: SessionFallbackView | null | undefined, subscribe?: FallbackSubscribe) {
  const [local, setLocal] = useState<SessionFallbackView | null | undefined>(view)
  const [error, setError] = useState<string | null>(null)
  // `gen` changes with the session, so nothing still on its way for the old one lands;
  // `seq` orders picks within a session, so only the newest pick moves the chip.
  const gen = useRef(0)
  const seq = useRef(0)
  const inFlight = useRef(0)
  const confirmed = useRef(view)
  const viewKey = JSON.stringify(view ?? null)

  const accept = (next: SessionFallbackView | null | undefined) => {
    confirmed.current = next
    if (inFlight.current === 0) setLocal(next)
  }
  useEffect(() => { gen.current++; inFlight.current = 0; confirmed.current = view; setLocal(view); setError(null) }, [sessionId])
  useEffect(() => { accept(view); if (inFlight.current === 0) setError(null) }, [viewKey])
  useFallbackResync(sessionId, subscribe, gen, accept)
  return { local, setLocal, error, setError, gen, seq, inFlight, confirmed }
}

/**
 * Optimistic mode or target change with rollback to the last server-confirmed view.
 * A change shows at once; the server's own view (or, without one, the same change applied
 * to what it last confirmed) replaces it, and a refusal puts the confirmed view back.
 */
export function useFallbackMode(sessionId: string, view: SessionFallbackView | null | undefined, subscribe?: FallbackSubscribe, save?: FallbackSave) {
  const { local, setLocal, error, setError, gen, seq, inFlight, confirmed } = useFallbackView(sessionId, view, subscribe)

  /** Send one change and show it at once; `optimistic` is the view if the server accepts it.
   *  Resolves true when the server took it, false when it refused (the error is on the chip). */
  const change = (body: FallbackChange, optimistic: (view: SessionFallbackView) => SessionFallbackView): Promise<boolean> => {
    if (!local) return Promise.resolve(false)
    const session = gen.current
    const mine = ++seq.current
    inFlight.current++
    setLocal(optimistic(local))
    setError(null)
    return (save ? save(body) : api.updateSession(sessionId, body))
      .then((res) => {
        if (gen.current !== session) return true
        // What the server now holds, even when a newer pick has taken over the chip:
        // a later failure rolls back to it, not to the view before this pick.
        const next = parseFallbackView((res as { fallback?: unknown } | undefined | void)?.fallback) ?? optimistic(confirmed.current ?? local)
        confirmed.current = next
        if (seq.current === mine) setLocal(next)
        return true
      })
      .catch((err) => {
        if (gen.current !== session || seq.current !== mine) return false
        setLocal(confirmed.current ?? local)
        setError(err instanceof Error ? err.message : 'Fallback update failed')
        return false
      })
      .finally(() => { if (gen.current === session && --inFlight.current < 0) inFlight.current = 0 })
  }
  const pick = (value: string) => {
    const mode = value as SessionFallbackMode
    if (!local || mode === local.mode) return
    void change({ fallbackMode: mode }, (v) => withMode(v, mode))
  }
  const pickTarget = (choice: FallbackTargetChoice | null) => change({ fallbackTarget: choice }, (v) => withTarget(v, choice))
  return { local, error, pick, pickTarget }
}
