import { useQuery, useQueryClient } from "@tanstack/react-query"
import { accountsApi } from "@/lib/accounts-api"
import { PEOPLE_DIRECTORY_KEY } from "@/hooks/use-people-directory"

export const PEOPLE_KEY = ["people"] as const
export const PENDING_INVITES_KEY = ["people", "invites"] as const
export const sessionsKey = (id: string) => ["people", id, "sessions"] as const

export function usePeople() {
  return useQuery({ queryKey: PEOPLE_KEY, queryFn: accountsApi.listPeople })
}

export function usePendingInvites() {
  return useQuery({ queryKey: PENDING_INVITES_KEY, queryFn: accountsApi.listPendingInvites })
}

/** After any write: People, its invites and sessions (all under ["people"]), and the names Todos resolve through. */
export function useRefreshPeople() {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PEOPLE_KEY }),
      queryClient.invalidateQueries({ queryKey: PEOPLE_DIRECTORY_KEY }),
    ])
  }
}
