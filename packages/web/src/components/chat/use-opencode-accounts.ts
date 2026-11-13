import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { opencodeAccountChoices, type OpencodeAccountChoice } from './opencode-accounts'

const NONE: OpencodeAccountChoice[] = []

/**
 * The declared opencode accounts the chat pickers list apart. Read from the limits route (the only
 * place that names built-in accounts, whose models the registry does not mark), narrowed to opencode.
 * Advisory: a failed or absent read, or no declared account, yields none and the pickers render as before.
 */
export function useOpencodeAccounts(enabled: boolean): OpencodeAccountChoice[] {
  const { data } = useQuery({
    queryKey: queryKeys.engineLimits('opencode'),
    queryFn: () => api.getEngineLimits('opencode'),
    enabled,
    retry: false,
    staleTime: 60_000,
  })
  return useMemo(() => (data ? opencodeAccountChoices(data) : NONE), [data])
}
