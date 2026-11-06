import { useQuery } from "@tanstack/react-query"
import { api, type WorkItemCompactWire } from "@/lib/api"
import { useMember } from "@/hooks/use-principal"
import { TODO_QUERY_FRESHNESS } from "@/lib/query-keys"

/**
 * The open Todos a board member created that have left their boards, as the gateway lists them. Only a member asks. The key
 * sits under `work-items`, so every Todo change the live feed announces (including the `removed` the gateway sends when
 * one closes) refetches it with the board.
 */
export function useMovedOffBoard(): WorkItemCompactWire[] {
  const member = useMember() !== null
  const query = useQuery({
    queryKey: ["work-items", "moved-off-board"],
    queryFn: async ({ signal }) => (await api.listMovedOffBoard(signal)).workItems,
    enabled: member,
    ...TODO_QUERY_FRESHNESS,
  })
  return member ? query.data ?? [] : []
}
