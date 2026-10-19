import { get } from "./api"
import type { FallbackChainsResponse } from "@jinn/fallback-chain-wire"

/**
 * The fallback chains the Settings editor shows. A leaf beside `api.ts`, which
 * sits over its size budget. The shapes are the wire module's, shared with the
 * gateway (`@jinn/fallback-chain-wire`), so a response is typed exactly as the
 * gateway builds it.
 */

export type {
  FallbackChainSubject, FallbackChainsResponse, FallbackHop, FallbackLink, FallbackProfileOption,
  ResolvedFallbackLink, SessionFallbackChainView,
} from "@jinn/fallback-chain-wire"

/** `GET /api/fallback-chains`: every engine's and declared account's chain, as written and as it would run; with `employee`, that employee's too. */
export function fetchFallbackChains(employee?: string): Promise<FallbackChainsResponse> {
  return get<FallbackChainsResponse>(employee ? `/api/fallback-chains?employee=${encodeURIComponent(employee)}` : "/api/fallback-chains")
}
