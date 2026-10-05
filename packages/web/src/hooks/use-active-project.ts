import { useSyncExternalStore } from "react"

/* The project the operator is working in: a project id, `none` (the Todos that
 * belong to no project) or undefined (everything). One small external store so
 * the board's filter, the status bar's switcher and the chat list all read the
 * same answer, and so it survives a reload.
 *
 * Storage is a convenience, never a dependency: when it throws (private mode,
 * blocked site data) the value simply lives in memory for the tab. */

export const ACTIVE_PROJECT_STORAGE_KEY = "jinn-active-project"

let current: string | undefined
let loaded = false
const listeners = new Set<() => void>()

function readStored(): string | undefined {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)?.trim() || undefined
  } catch {
    return undefined
  }
}

function writeStored(value: string | undefined): void {
  try {
    if (value) window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, value)
    else window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
  } catch {
    /* in-memory only */
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function getActiveProject(): string | undefined {
  if (!loaded) {
    current = readStored()
    loaded = true
  }
  return current
}

export function setActiveProject(value: string | undefined): void {
  const next = value?.trim() || undefined
  if (next === getActiveProject()) return
  current = next
  writeStored(next)
  emit()
}

function onStorage(event: StorageEvent): void {
  // A clear() arrives with a null key; both mean another tab changed the value.
  if (event.key !== null && event.key !== ACTIVE_PROJECT_STORAGE_KEY) return
  const next = readStored()
  if (next === current) return
  current = next
  emit()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

/** The active project id, `none`, or undefined. Re-renders on change, in any tab. */
export function useActiveProject(): string | undefined {
  return useSyncExternalStore(subscribe, getActiveProject, () => undefined)
}

/** Forget the cached value so the next read goes back to storage. For tests. */
export function resetActiveProjectForTests(): void {
  current = undefined
  loaded = false
}
