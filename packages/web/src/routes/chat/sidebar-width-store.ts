import { useSyncExternalStore } from 'react'
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  loadSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
  saveSidebarWidth,
} from './sidebar-width'

/**
 * The saved list width as shared state: the column reads it to draw, and the pane cap reads it
 * to know how much room the thread really has. localStorage stays the single source; this only
 * tells subscribers when it changed (here, or in another tab).
 */
const listeners = new Set<() => void>()

export function savedSidebarWidth(): number {
  return loadSidebarWidth() ?? DEFAULT_SIDEBAR_WIDTH
}

/** null forgets the saved width, so the default applies again. */
export function storeSidebarWidth(width: number | null): void {
  saveSidebarWidth(width)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SIDEBAR_WIDTH_STORAGE_KEY) listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useSavedSidebarWidth(): number {
  return useSyncExternalStore(subscribe, savedSidebarWidth, () => DEFAULT_SIDEBAR_WIDTH)
}

/**
 * The window width the pane cap (grid-layout.ts capForViewport) should see. The cap budgets a
 * 280px list, so a wider one takes its extra from the window: the thread keeps room for every
 * column the cap allows, and panes fold away as they do in a narrower window. A list narrower
 * than the default gives nothing back, which keeps the cap where it always was.
 */
export function capWindowWidth(windowWidth: number, savedWidth: number): number {
  return windowWidth - Math.max(0, clampSidebarWidth(savedWidth, windowWidth) - DEFAULT_SIDEBAR_WIDTH)
}
