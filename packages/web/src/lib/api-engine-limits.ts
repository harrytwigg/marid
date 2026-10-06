import type { EngineLimitEngineSnapshot } from "@/lib/api"

/**
 * One account's snapshot on the Limits page, for an engine with more than one
 * account. A leaf beside `api.ts`, which is at its size budget. Mirrors the
 * gateway's `accounts` block on `GET /api/engine-limits`.
 */
export interface EngineLimitAccountSnapshot extends EngineLimitEngineSnapshot {
  /** The account key: "claude" (default), "claude:<8hex>" or "claude@<user>@<host>[:<8hex>]". */
  account: string
  /** What the card is called: the default's own name, a profile or declared name, or "user@host". */
  label: string
  location: { kind: "local" } | { kind: "remote"; host: string }
  /** The employees on this account; may be empty, as it is for the default. */
  employees: string[]
  /** No live reading: an expired token, a locked remote Keychain, or a host never read. */
  noReading?: true
  /** The remote host is asleep or unreachable; `windows` and `refreshedAt` are its last reading, if any. */
  hostUnreachable?: true
  /** Health recorded this account at its limit; `until` is the ISO reset. */
  exhausted?: { until?: string }
}

export interface EngineLimitsResponse {
  generatedAt: string
  default: string
  engines: Record<string, EngineLimitEngineSnapshot>
  /** Absent when every engine has one account. Only engines with more than one appear,
   *  the default account first (its windows equal `engines[engine]`). */
  accounts?: Record<string, EngineLimitAccountSnapshot[]>
}
