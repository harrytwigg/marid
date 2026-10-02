/** Small formatters shared by the Auto-Dispatch page's cards. */

export function formatMinutes(minutes: number): string {
  const abs = Math.abs(Math.round(minutes))
  const sign = minutes < 0 ? "-" : ""
  if (abs < 60) return `${sign}${abs} min`
  if (abs < 24 * 60) {
    const rest = abs % 60
    return `${sign}${Math.floor(abs / 60)} h${rest ? ` ${rest} min` : ""}`
  }
  const hours = Math.floor((abs % (24 * 60)) / 60)
  return `${sign}${Math.floor(abs / (24 * 60))} d${hours ? ` ${hours} h` : ""}`
}

export function agoLabel(atMs: number, now: number): string {
  const mins = Math.max(0, Math.round((now - atMs) / 60_000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** `Tue 14:00`, in the viewer's zone — enough to place an instant this week. */
export function shortClock(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
}
