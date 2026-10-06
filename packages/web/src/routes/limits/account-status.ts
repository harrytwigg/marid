import type { EngineLimitAccountSnapshot } from "@/lib/api"
import { agoLabel, resetLabel } from "./format"

export interface AccountStatus {
  color: string
  label: string
  note: string
}

/**
 * What an account's own flags say about it, in precedence order: at its limit,
 * then host asleep, then no live reading. Null when none is set, and the card
 * shows its ordinary freshness badge. Fixed copy only — the snapshot's raw
 * `error` is never shown, and nothing here suggests waking a host.
 */
export function accountStatus(account: EngineLimitAccountSnapshot, now: number): AccountStatus | null {
  if (account.exhausted) {
    const reset = resetLabel(account.exhausted.until, now)
    return {
      color: "var(--system-red)",
      label: "At limit",
      note: reset ? `Recorded at its limit — ${reset}.` : "Recorded at its limit.",
    }
  }
  if (account.hostUnreachable) {
    return {
      color: "var(--system-orange)",
      // The age is the last reading's; a host never read has none to show.
      label: account.refreshedAt && account.windows?.length ? `Host asleep · ${agoLabel(account.refreshedAt, now)}` : "Host asleep",
      note: "The host is asleep or unreachable; showing the last reading.",
    }
  }
  if (account.noReading) {
    return {
      color: "var(--text-tertiary)",
      label: "No live reading",
      note: "No live reading yet — this account’s token has expired or it has not been read. A session on it refreshes the reading.",
    }
  }
  return null
}
