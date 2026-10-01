import type { Employee } from "@/lib/api"

/** Compact relative time: "22m", "4h", "Yesterday", "Jul 4". Past only. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const diff = Math.max(0, now - t)
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day === 1) return "Yesterday"
  if (day < 7) return `${day}d`
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** The forward-looking counterpart of `formatRelativeTime`, which clamps the
 *  future away by construction: how long a park has left, for a chip that ticks
 *  down. Empty once the moment has passed or when it will not parse, so the
 *  caller renders nothing rather than a countdown stuck at zero. */
export function formatCountdown(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t) || t <= now) return ""
  const min = Math.ceil((t - now) / 60000)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return min % 60 === 0 ? `${hr}h` : `${hr}h ${min % 60}m`
  return `${Math.floor(hr / 24)}d`
}

/** An escalation event's own reason, phrased for the banner and the card. A
 *  guard that escalates without one of these leaves the why-line blank. */
export function escalationReasonLabel(reason: unknown): string | null {
  if (reason === "max-rounds-exhausted") return "Review rounds exhausted"
  if (reason === "block_loop_detected") return "Blocked again for the same reason"
  return typeof reason === "string" && reason ? reason : null
}

/** The reserved assignee value for the operator; it is not on the roster. */
export const OPERATOR_ASSIGNEE = "@operator"

/** Resolve a display name for an assignee employee key, falling back to the key. */
export function displayNameOf(assignee: string | null, byName: Map<string, Employee>): string {
  if (!assignee) return ""
  if (assignee === OPERATOR_ASSIGNEE) return "You"
  return byName.get(assignee)?.displayName ?? assignee
}
