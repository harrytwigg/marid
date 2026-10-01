import type { Employee, WorkItemEventWire } from "@/lib/api"

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

/** Why a Todo stopped in `status`: the note, or the escalation's reason, on
 *  the newest move into it, and that move. A boot migration out of a retired
 *  status (`escalated`) is read through to the move into that status, which is
 *  where the reason was given. */
export function stopReasonOf(events: readonly WorkItemEventWire[], current: string): { note: string | null; event: WorkItemEventWire | null } {
  let status = current
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.toStatus !== status) continue
    if (e.detail?.reason === "retired-status" && e.fromStatus) {
      status = e.fromStatus
      continue
    }
    const note = moveReason(e)
    if (note || e.kind === "status_change") return { note, event: e }
  }
  return { note: null, event: null }
}

/** The newest move into `current`, read through a boot migration out of a
 *  retired status: that move, and the status it really entered (`escalated`
 *  for a migrated escalation). */
export function stopMoveOf(events: readonly WorkItemEventWire[], current: string): { event: WorkItemEventWire; entered: string } | null {
  let status = current
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.toStatus !== status) continue
    if (e.detail?.reason !== "retired-status" || !e.fromStatus) return { event: e, entered: status }
    status = e.fromStatus
  }
  return null
}

/** The reason one move states: its note, else an escalation's mapped reason. */
function moveReason(e: WorkItemEventWire): string | null {
  const note = typeof e.detail?.note === "string" ? e.detail.note.trim() : ""
  return note || (e.kind === "escalated" ? escalationReasonLabel(e.detail?.reason) : null)
}

/** The reserved assignee value for the operator; it is not on the roster. */
export const OPERATOR_ASSIGNEE = "@operator"

/** The operator as an assignee-picker row, listed before the employees. A
 *  system employee is never offered: it routes Todos but owns none. */
export const OPERATOR_ROW: Pick<Employee, "name" | "displayName" | "department"> = { name: OPERATOR_ASSIGNEE, displayName: "You (operator)", department: "" }

/** Resolve a display name for an assignee employee key, falling back to the key. */
export function displayNameOf(assignee: string | null, byName: Map<string, Employee>): string {
  if (!assignee) return ""
  if (assignee === OPERATOR_ASSIGNEE) return "You"
  return byName.get(assignee)?.displayName ?? assignee
}
