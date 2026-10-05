import type { WorkItemCompactWire } from "./api"

const DAY_MS = 24 * 60 * 60 * 1000

// ── History grouping (closed-status filters regroup by date, §3) ────────────
export type DateBucket = "today" | "yesterday" | "week" | "earlier"
export const DATE_BUCKETS: readonly DateBucket[] = ["today", "yesterday", "week", "earlier"]
export const DATE_BUCKET_LABEL: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
}

export function dateBucketOf(iso: string, now: number): DateBucket {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "earlier"
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  if (t >= startOfToday.getTime()) return "today"
  if (t >= startOfToday.getTime() - DAY_MS) return "yesterday"
  if (t >= startOfToday.getTime() - 6 * DAY_MS) return "week"
  return "earlier"
}

export interface HistoryGroup {
  bucket: DateBucket
  label: string
  items: WorkItemCompactWire[]
}

/** Newest-first date grouping for history views. Empty buckets don't render. */
export function groupHistory(items: WorkItemCompactWire[], now: number): HistoryGroup[] {
  const buckets = new Map<DateBucket, WorkItemCompactWire[]>()
  for (const b of DATE_BUCKETS) buckets.set(b, [])
  for (const it of items) buckets.get(dateBucketOf(it.updatedAt, now))!.push(it)
  return DATE_BUCKETS.map((b) => {
    const list = buckets.get(b)!.slice()
    list.sort((a, x) => (Date.parse(x.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    return { bucket: b, label: DATE_BUCKET_LABEL[b], items: list }
  }).filter((g) => g.items.length > 0)
}
