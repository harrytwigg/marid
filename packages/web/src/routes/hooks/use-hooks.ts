import { useCallback, useEffect, useState } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getHookRun,
  listHooks,
  listHookRuns,
  setHookEnabled,
  type BoardHook,
  type HookRunFilters,
} from "@/lib/api-hooks"
import { queryKeys } from "@/lib/query-keys"
import { describeFailure } from "./format"

/**
 * The Hooks page's data layer. The gateway broadcasts `hooks:run` when a run is
 * written or finishes, and `useQueryInvalidation` refetches on it; the slow poll
 * is only a backstop for a socket that missed one.
 */
export const HOOKS_REFRESH_INTERVAL_MS = 60_000
export const RUNS_PAGE_SIZE = 50

export function useHooks() {
  return useQuery({
    queryKey: queryKeys.hooks.hooks,
    queryFn: ({ signal }) => listHooks({ signal }),
    refetchInterval: HOOKS_REFRESH_INTERVAL_MS,
  })
}

export interface HookRunFilterState {
  hook: string
  outcome: string
  todo?: string
}

/** The run log, newest first, paged by the `before` cursor the gateway returns.
 *  The filters are the query key's identity, so switching one reads that slice
 *  instead of filtering the last one client-side. */
export function useHookRuns(filters: HookRunFilterState) {
  const key = { hook: filters.hook, outcome: filters.outcome, todo: filters.todo ?? "" }
  return useInfiniteQuery({
    queryKey: queryKeys.hooks.runs(key),
    queryFn: ({ pageParam, signal }) => {
      const request: HookRunFilters = { limit: RUNS_PAGE_SIZE }
      if (filters.hook) request.hook = filters.hook
      if (filters.outcome) request.status = filters.outcome
      if (filters.todo) request.todo = filters.todo
      if (pageParam) request.before = pageParam
      return listHookRuns(request, { signal })
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: HOOKS_REFRESH_INTERVAL_MS,
  })
}

/** One run in full, fetched the first time its row is opened. */
export function useHookRun(id: string | null) {
  return useQuery({
    queryKey: queryKeys.hooks.run(id ?? ""),
    queryFn: ({ signal }) => getHookRun(id as string, { signal }),
    enabled: id !== null,
  })
}

/** Flip a hook's `enabled`; the list is re-read so the row settles on what the
 *  gateway actually wrote. A 403 is the operator-only rule and is reported,
 *  never retried. */
export function useSetHookEnabled() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => setHookEnabled(name, enabled),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.hooks.hooks })
    },
  })
}

/** One row's switch: the mutation plus the failure line it shows in place. */
export function useHookToggle(hook: BoardHook) {
  const toggle = useSetHookEnabled()
  const [error, setError] = useState<string | null>(null)
  const onCheckedChange = useCallback(
    (enabled: boolean) => {
      setError(null)
      toggle.mutate(
        { name: hook.name, enabled },
        { onError: (cause: unknown) => setError(describeFailure(cause, "Could not change the hook.")) },
      )
    },
    [toggle, hook.name],
  )
  return { error, onCheckedChange }
}

/** A clock that moves on its own, so relative labels stay honest between reads. */
export function useNowTick(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
