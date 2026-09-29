/**
 * The phone's open-chat tabs: an ordered list of the chats the operator opened.
 *
 * Unlike the working-set slots, nothing back-fills this list from gateway
 * activity, and unlike the touch log it is not re-ranked by recency — a tab
 * keeps its place while it is focused, and only leaves when it is closed.
 */

export const MOBILE_TABS_STORAGE_KEY = 'jinn-mobile-session-tabs'

/** Every tab costs a last-message fetch for its updated dot, so the list stays short. */
export const MOBILE_TABS_LIMIT = 8

interface PersistedMobileTabs {
  version: 1
  sessionIds: string[]
}

type MobileTabsStorage = Pick<Storage, 'getItem' | 'setItem'>

function uniqueIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))]
}

/** Append an opened chat. A chat that already has a tab keeps its place, and at
 *  the limit the oldest tab other than the new one makes room. */
export function openMobileTab(tabs: readonly string[], rawSessionId: string): string[] {
  const sessionId = rawSessionId.trim()
  if (!sessionId || tabs.includes(sessionId)) return tabs as string[]
  const next = [...tabs, sessionId]
  return next.length > MOBILE_TABS_LIMIT ? next.slice(next.length - MOBILE_TABS_LIMIT) : next
}

/** The tab to show once `sessionId` closes: the one before it, else the one
 *  after, else none. Only meaningful when the closed tab was the focused one. */
export function neighbourAfterClose(tabs: readonly string[], sessionId: string): string | null {
  const index = tabs.indexOf(sessionId)
  if (index < 0) return null
  return tabs[index - 1] ?? tabs[index + 1] ?? null
}

export function closeMobileTab(tabs: readonly string[], sessionId: string): string[] {
  return tabs.includes(sessionId) ? tabs.filter((id) => id !== sessionId) : tabs as string[]
}

export function serializeMobileTabs(tabs: readonly string[]): string {
  const persisted: PersistedMobileTabs = { version: 1, sessionIds: uniqueIds(tabs).slice(0, MOBILE_TABS_LIMIT) }
  return JSON.stringify(persisted)
}

export function restoreMobileTabs(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedMobileTabs>
    if (parsed.version !== 1) return []
    return uniqueIds(parsed.sessionIds).slice(0, MOBILE_TABS_LIMIT)
  } catch {
    return []
  }
}

export function persistMobileTabs(storage: MobileTabsStorage, tabs: readonly string[]): void {
  try {
    storage.setItem(MOBILE_TABS_STORAGE_KEY, serializeMobileTabs(tabs))
  } catch {
    // Private browsing and quota failures must not make chat navigation fail.
  }
}

export function loadPersistedMobileTabs(storage: MobileTabsStorage): string[] {
  try {
    return restoreMobileTabs(storage.getItem(MOBILE_TABS_STORAGE_KEY))
  } catch {
    return []
  }
}
