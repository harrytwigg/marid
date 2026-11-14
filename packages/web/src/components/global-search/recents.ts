const RECENT_KEY = "hundredfold-command-recent"
const MAX_RECENT = 5

export interface RecentItem {
  id: string
  label: string
  href: string
  type: string
}

/** At most `MAX_RECENT`, however many a longer-lived store happens to hold —
 *  the cap belongs to the list, not only to the last thing that wrote it. */
export function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? (JSON.parse(raw) as RecentItem[]).slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

export function saveRecent(item: RecentItem) {
  const items = loadRecent().filter(r => r.id !== item.id)
  items.unshift(item)
  localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)))
}
