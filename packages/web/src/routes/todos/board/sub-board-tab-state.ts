import { useCallback, useSyncExternalStore } from "react"
import type { SubBoardDepth } from "./board-route"

/* A pinned sub-board tab's own state: how deep it reads and the filters it carries, one record per Todo in
 * localStorage (`jinn-sub-board-tab:<todoId>`), so a reload brings the tab back where it was. Like the Todos tab's
 * location (todos-tab-location.tsx) it is read through a small module store, so the tab follows a write made while
 * it is on screen, and every storage access is guarded: a browser that will not take it keeps the state in memory
 * for the page's life instead. The record goes when the tab closes (clearSubBoardTabState). */

const KEY_PREFIX = "jinn-sub-board-tab:"
const VERSION = 1

export interface SubBoardTabState {
  depth: SubBoardDepth
  /** The filter set, as the query string the filter bar writes. */
  search: string
}

const DEFAULT_STATE: SubBoardTabState = { depth: "children", search: "" }

/** Records storage would not take, or is not there to take, by Todo. */
const memory = new Map<string, string>()
const cache = new Map<string, { raw: string | null; value: SubBoardTabState }>()
const listeners = new Map<string, Set<() => void>>()

const keyOf = (todoId: string) => `${KEY_PREFIX}${todoId}`

function readRaw(todoId: string): string | null {
  const held = memory.get(todoId)
  if (held !== undefined) return held
  try {
    return localStorage.getItem(keyOf(todoId))
  } catch {
    return null
  }
}

function parse(raw: string | null): SubBoardTabState {
  if (!raw) return DEFAULT_STATE
  try {
    const stored = JSON.parse(raw) as { version?: unknown; depth?: unknown; search?: unknown }
    if (stored.version !== VERSION) return DEFAULT_STATE
    return {
      depth: stored.depth === "all" ? "all" : "children",
      search: typeof stored.search === "string" ? stored.search : "",
    }
  } catch {
    return DEFAULT_STATE
  }
}

/** The stored state; the same object until the stored text changes, as a store snapshot must be. */
export function readSubBoardTabState(todoId: string): SubBoardTabState {
  const raw = readRaw(todoId)
  const hit = cache.get(todoId)
  if (hit && hit.raw === raw) return hit.value
  const value = parse(raw)
  cache.set(todoId, { raw, value })
  return value
}

function notify(todoId: string): void {
  listeners.get(todoId)?.forEach((listener) => listener())
}

function subscribe(todoId: string, listener: () => void): () => void {
  const set = listeners.get(todoId) ?? new Set<() => void>()
  set.add(listener)
  listeners.set(todoId, set)
  // Another window writing the same record moves this one too.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === keyOf(todoId)) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(todoId)
    window.removeEventListener("storage", onStorage)
  }
}

export function writeSubBoardTabState(todoId: string, next: SubBoardTabState): void {
  const current = readSubBoardTabState(todoId)
  if (current.depth === next.depth && current.search === next.search) return
  const raw = JSON.stringify({ version: VERSION, depth: next.depth, search: next.search })
  try {
    localStorage.setItem(keyOf(todoId), raw)
    memory.delete(todoId)
  } catch {
    memory.set(todoId, raw)
  }
  notify(todoId)
}

/** Forgets a Todo's tab record: the tab closed, so the next one opened for it starts at the top. */
export function clearSubBoardTabState(todoId: string): void {
  memory.delete(todoId)
  cache.delete(todoId)
  try {
    localStorage.removeItem(keyOf(todoId))
  } catch {
    /* nothing stored that could be read back */
  }
  notify(todoId)
}

/** The tab's state for one Todo, and the two moves it makes. A depth change keeps the filters; a filter change
 *  keeps the depth. */
export function useSubBoardTabState(todoId: string) {
  const state = useSyncExternalStore(
    useCallback((listener) => subscribe(todoId, listener), [todoId]),
    () => readSubBoardTabState(todoId),
    () => DEFAULT_STATE,
  )
  const setDepth = useCallback(
    (depth: SubBoardDepth) => writeSubBoardTabState(todoId, { ...readSubBoardTabState(todoId), depth }),
    [todoId],
  )
  const setSearch = useCallback(
    (search: string) => writeSubBoardTabState(todoId, { ...readSubBoardTabState(todoId), search }),
    [todoId],
  )
  return { state, setDepth, setSearch }
}
