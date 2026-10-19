/**
 * The Todo run ledger's wire shapes — one row per work ATTEMPT.
 *
 * Kept apart from the rest of the client because a run carries a pairing rule
 * none of the other work-item shapes do: an attempt is OPEN (no end, no
 * outcome) or SETTLED (both), never half of each. A reader that forgets the
 * pair invents an outcome for work still in flight. `api.ts` re-exports all of
 * it, so no caller had to move with it — and nothing here imports a VALUE back
 * from `api.ts`, which is what keeps the re-export from reading a function
 * before it exists.
 */

/** How an attempt ended. Frozen: the gateway's DDL pins the same six words, so
 *  a new one is a schema change, not a string. `rate_limited` is not a failure —
 *  it is the provider saying "not now". */
export type WorkItemRunOutcomeWire =
  | "completed" | "blocked" | "crashed" | "timed_out" | "abandoned" | "rate_limited"

/** What an attempt hands the next one. Everything is optional — the gateway
 *  stores and serves what the attempt reported, it never invents it, so an
 *  absent field means "not reported" rather than "empty". */
export interface WorkItemRunHandoffWire {
  changedFiles?: string[]
  verification?: string
  retryNotes?: string
  residualRisk?: string
}

/** One attempt at a Todo. `endedAt` and `outcome` are null together while the
 *  attempt is still running; `handoff` is `{}` when it reported nothing. */
export interface WorkItemRunWire {
  id: string
  workItemId: string
  sessionId: string
  startedAt: string
  endedAt: string | null
  outcome: WorkItemRunOutcomeWire | null
  summary: string | null
  handoff: WorkItemRunHandoffWire
  error: string | null
}
