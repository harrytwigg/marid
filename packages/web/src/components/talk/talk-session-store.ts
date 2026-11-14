import { useSyncExternalStore } from "react"
import { browserInstanceId } from "./context/browser-instance"

/**
 * Which talk session is open, for the surfaces that have to name one.
 *
 * Held outside React because the session belongs to the realtime transport,
 * which is not a component. `transport/use-talk-session.ts` is the only thing
 * that calls {@link setTalkSessionId}: it names the session the moment
 * `POST /api/talk/sessions` returns one and clears it on close, on a failed
 * connect, and on unload. Everything downstream — the action log's gateway
 * copy above all — reads the answer from here rather than being handed it.
 */

let sessionId: string | null = null
const listeners = new Set<() => void>()
const RESUMABLE_KEY_PREFIX = "hundredfold-talk-resumable:"

function resumableKey(): string {
  return `${RESUMABLE_KEY_PREFIX}${browserInstanceId()}`
}

/** Remember a conversation that can be resumed after this page is gone. */
export function rememberResumableTalkSession(id: string): void {
  if (typeof sessionStorage === "undefined") return
  sessionStorage.setItem(resumableKey(), id)
}

/** The candidate belongs to this browser tab's stable identity, never another. */
export function readResumableTalkSession(): string | null {
  if (typeof sessionStorage === "undefined") return null
  return sessionStorage.getItem(resumableKey())
}

/** Avoid clearing a newer candidate when an older async teardown finishes late. */
export function clearResumableTalkSession(expectedId?: string): void {
  if (typeof sessionStorage === "undefined") return
  const key = resumableKey()
  if (expectedId && sessionStorage.getItem(key) !== expectedId) return
  sessionStorage.removeItem(key)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Name the open talk session, or `null` once it has closed. */
export function setTalkSessionId(id: string | null): void {
  if (id === sessionId) return
  sessionId = id
  for (const listener of listeners) listener()
}

export function useTalkSessionId(): string | null {
  return useSyncExternalStore(subscribe, () => sessionId, () => null)
}
