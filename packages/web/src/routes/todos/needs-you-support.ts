import type { WorkItemCompactWire } from "@/lib/api"
import { isParked } from "@/lib/parked"
import { formatCountdown } from "./util"

/** Which of the inbox's kickers an entry belongs to. */
export type AttentionKind = "blocked" | "recovering" | "manager"

export const ATTENTION_GROUPS: { kind: AttentionKind; label: string }[] = [
  { kind: "recovering", label: "Recovering automatically" },
  { kind: "manager", label: "Manager attention" },
  { kind: "blocked", label: "Blocked" },
]

export function attentionKind(item: WorkItemCompactWire): AttentionKind {
  if (item.attentionLane === "recovering") return "recovering"
  if (item.attentionLane === "manager") return "manager"
  return "blocked"
}

/** A stopped Todo's own account of the wait (PLA-157), for the inbox line that
 *  otherwise says "Blocked and waiting on a decision or missing input." to a
 *  Todo that is waiting on a quota window and not on anybody. Null when the stop
 *  carries neither, and the caller's fallback copy still applies. */
export function stopCauseQuote(item: WorkItemCompactWire, now = Date.now()): string | null {
  if (item.unblockHint) return `${item.unblockHint.what} — ${item.unblockHint.who}`
  if (!isParked(item.parkedUntil, now)) return null
  return `Waiting on a clock, not on you — back in ${formatCountdown(item.parkedUntil!, now)}.`
}
