const STORAGE_KEY = "hundredfold-talk-browser-instance"
let fallback: string | null = null

function freshId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Stable across a reload in this tab, distinct in a separate browser tab. */
export function browserInstanceId(): string {
  if (fallback) return fallback
  if (typeof sessionStorage === "undefined") return (fallback = freshId())
  const held = sessionStorage.getItem(STORAGE_KEY)
  if (held) return (fallback = held)
  const created = freshId()
  sessionStorage.setItem(STORAGE_KEY, created)
  return (fallback = created)
}
