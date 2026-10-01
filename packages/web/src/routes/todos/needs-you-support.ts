import type { WorkItemCompactWire } from "@/lib/api"
import { isParked } from "@/lib/parked"
import { formatCountdown } from "./util"
import type { StateGlyphKey } from "./state-glyph"

/** Which of the inbox's kickers an entry belongs to. A pending gate wins
 *  over the status, because a Todo can be blocked AND holding a decision. */
export type AttentionKind = "approval" | "blocked" | "recovering" | "manager"

export const ATTENTION_GROUPS: { kind: AttentionKind; label: string }[] = [
  { kind: "recovering", label: "Recovering automatically" },
  { kind: "manager", label: "Manager attention" },
  { kind: "approval", label: "Approvals" },
  { kind: "blocked", label: "Blocked" },
]

export function attentionKind(item: WorkItemCompactWire): AttentionKind {
  if (item.attentionLane === "recovering") return "recovering"
  if (item.attentionLane === "manager") return "manager"
  if (item.approvalState === "pending") return "approval"
  return "blocked"
}

export function stateKey(kind: AttentionKind): StateGlyphKey {
  if (kind === "approval" || kind === "manager") return "approval"
  if (kind === "recovering") return "blocked"
  return kind
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
