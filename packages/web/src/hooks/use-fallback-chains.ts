import { useQuery } from '@tanstack/react-query'
import type { FallbackChainSubject } from '@jinn/fallback-chain-wire'
import { fetchFallbackChains } from '@/lib/fallback-chains-api'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'

/**
 * The gateway's reading of every chain: declared profiles, each chain as written and
 * as it would run, with limit state per link. With `employee` that employee's
 * subject is added. Advisory for the editor: a gateway without the route, or a
 * failed read, leaves the editor on the chains as config states them.
 */
export function useFallbackChains(employee?: string) {
  return useQuery({
    queryKey: queryKeys.fallbackChains(employee),
    queryFn: () => fetchFallbackChains(employee),
    retry: false,
    staleTime: 15_000,
  })
}

/** One subject out of a chains response. */
export function findSubject(
  subjects: FallbackChainSubject[] | undefined,
  kind: FallbackChainSubject['kind'],
  id: string,
): FallbackChainSubject | undefined {
  return subjects?.find((s) => s.kind === kind && s.id === id)
}

/** The gateway's sentences about a chain it refused part of or could not use (a duplicate it loaded with a warning, say); none when it has no complaint. */
export function subjectProblems(subject: FallbackChainSubject | undefined): string[] {
  return (subject as (FallbackChainSubject & { problems?: string[] }) | undefined)?.problems ?? []
}

/** What the gateway says of a chain (its effective links, their health, who it is the default for) moves with every config or employee write: read it again. Covers the employee variants too. */
export function refreshFallbackChains(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.fallbackChains().slice(0, 1) })
}
