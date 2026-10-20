import type { FallbackSkipReason } from "@jinn/fallback-chain-wire"

/* How a chain's facts read, in one place so the diagram, the hop card and the
 * editor say the same thing. */

/** Why a link is passed over, as a sentence. */
export const SKIP_REASON_TEXT: Record<FallbackSkipReason, string> = {
  tried: "Already tried in this run",
  "not-installed": "This engine is not installed",
  scoped: "A department-scoped session runs on Claude accounts only",
  remote: "Cannot run on the session's host",
  exhausted: "At its limit; tried only when nothing else is left",
  "model-not-served": "This engine does not serve that model",
  "profile-unknown": "No declared account has that name",
}

/** A skip as a sentence, with the gateway's detail (which host lacks the engine) when it gave one. */
export function skipText(reason: FallbackSkipReason, detail?: string): string {
  const text = SKIP_REASON_TEXT[reason] ?? reason
  return detail ? `${text}: ${detail}` : text
}

/** A reset as a time of day when it is today, else with its date. Null when the
 *  value is absent or not a date: a misparsed record reads as "no time", never as
 *  "Invalid Date". */
export function formatReset(until: string | undefined, now: number = Date.now()): string | null {
  if (!until) return null
  const at = new Date(until)
  if (Number.isNaN(at.getTime())) return null
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  const sameDay = new Date(now).toDateString() === at.toDateString()
  return sameDay ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`
}

/** "62% used" for a reading with one, else null. */
export function formatUsed(percent: number | undefined): string | null {
  return typeof percent === "number" && Number.isFinite(percent) ? `${Math.round(percent)}% used` : null
}
