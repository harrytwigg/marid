import { get } from "./api"
import type { FallbackChainEntry, FallbackChainsResponse } from "@jinn/fallback-chain-wire"

/* The fallback-chain routes' client call, and the employee fields it adds. Kept
 * beside api.ts rather than inside it, which is at its size budget. */

/** `fallback` on an employee, as GET and PATCH /api/org/employees carry it.
 *  Absent or null: the employee inherits the account or engine default. */
export interface EmployeeFallbackFields {
  fallback?: FallbackChainEntry[] | null
}

export function fetchFallbackChains(employee?: string): Promise<FallbackChainsResponse> {
  const query = employee ? `?employee=${encodeURIComponent(employee)}` : ""
  return get<FallbackChainsResponse>(`/api/fallback-chains${query}`)
}
