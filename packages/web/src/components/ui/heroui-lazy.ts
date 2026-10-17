import { useSyncExternalStore } from "react"

/**
 * React Aria is ~25 KB gzip, far more than the headroom the initial path and
 * the board chunk have, so the HeroUI half of an adapter is loaded on demand.
 * Until it arrives the adapter draws the same control from plain elements that
 * wear HeroUI's own class names (its stylesheet is what makes them look right),
 * so nothing changes shape when the swap happens, and a press that lands before
 * it still reaches the app's handler.
 */
export interface LazyHeroUI<M> {
  /** The loaded module, or undefined until it has arrived. */
  use(): M | undefined
  /** Starts loading now. Safe to call repeatedly. */
  preload(): Promise<M>
}

const registry = new Set<LazyHeroUI<unknown>>()
const resets = new Set<() => void>()

function whenIdle(task: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(task, { timeout: 2000 })
  } else {
    setTimeout(task, 200)
  }
}

export function createLazyHeroUI<M>(load: () => Promise<M>): LazyHeroUI<M> {
  let loaded: M | undefined
  let pending: Promise<M> | undefined
  let scheduled = false
  const listeners = new Set<() => void>()

  const preload = () => {
    pending ??= load().then(
      (module) => {
        loaded = module
        listeners.forEach((listener) => listener())
        return module
      },
      (error: unknown) => {
        // A failed chunk (offline, stale deploy) leaves the plain controls in
        // place, and the next mount may try again.
        pending = undefined
        scheduled = false
        throw error
      },
    )
    return pending
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (!loaded && !scheduled) {
      scheduled = true
      whenIdle(() => void preload().catch(() => undefined))
    }
    return () => {
      listeners.delete(listener)
    }
  }
  const snapshot = () => loaded

  const lazy: LazyHeroUI<M> = {
    use: () => useSyncExternalStore(subscribe, snapshot, snapshot),
    preload,
  }
  registry.add(lazy as LazyHeroUI<unknown>)
  resets.add(() => {
    loaded = undefined
    pending = undefined
    scheduled = false
  })
  return lazy
}

/** Loads every HeroUI module the imported adapters declared. */
export function preloadHeroUI(): Promise<unknown[]> {
  return Promise.all([...registry].map((lazy) => lazy.preload()))
}

/** Test seam: forgets what has loaded, so the not-yet-loaded controls can be rendered. */
export function resetHeroUIForTests() {
  resets.forEach((reset) => reset())
}
